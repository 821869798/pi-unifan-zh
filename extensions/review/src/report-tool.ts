/**
 * Implementation of the `pi_review_report` tool. Loaded by index.ts and
 * registered as a real Pi tool — the main agent calls it once after the
 * workflowScript returns.
 *
 * Pure logic — does not touch pi. The wrapper in `src/tool-wrapper.ts`
 * adapts it to `pi.registerTool`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { enforceGateOutput, type VerdictPolicy } from "./gate-enforce.js";
import { buildReportFromWorkflow, renderReport } from "./report.js";
import { readManifest, RunManifest } from "./review-report.js";
import { removeWorkspaceRoot } from "./target-workspace.js";
import type {
	GateDisposition,
	Issue,
	ReviewerOutput,
	Verdict,
} from "./types.js";

export interface ReportToolInput {
	runId: string;
	workflowReturn: unknown;
	threshold?: number;
	verdictPolicy?: VerdictPolicy;
	/** Root of the prepared run; defaults to process.cwd(). Callers with a
	 *  tool/command context should pass ctx.cwd so the manifest is found
	 *  regardless of the hosting process's cwd. */
	cwd?: string;
}

export interface ReportToolSuccess {
	ok: true;
	runId: string;
	verdict: Verdict | "partial" | "no-gate" | "error";
	markdown: string;
	report: ReturnType<typeof buildReportFromWorkflow>;
	persistedEntry?: unknown;
}

export interface ReportToolFailure {
	ok: false;
	error: string;
}

export type ReportToolResult = ReportToolSuccess | ReportToolFailure;

/** Map legacy `ReviewerOutput` shape to v0.7 shape (status, coverage). */
function adaptReviewer(so: unknown): ReviewerOutput {
	if (!so || typeof so !== "object") {
		return { status: "limited", issues: [], summary: "", coverage: emptyCoverage() };
	}
	const obj = so as Partial<ReviewerOutput> & {
		issues?: unknown;
		summary?: unknown;
		status?: unknown;
		coverage?: unknown;
	};
	const issues = Array.isArray(obj.issues)
		? (obj.issues as Issue[]).filter(isIssueLike).map(normalizeIssue)
		: [];
	return {
		status: obj.status === "ok" || obj.status === "limited" || obj.status === "skipped"
			? obj.status
			: "limited",
		issues,
		summary: typeof obj.summary === "string" ? obj.summary : "",
		coverage: isCoverage(obj.coverage)
			? obj.coverage
			: emptyCoverage(),
	};
}

function isIssueLike(v: unknown): v is Issue {
	return !!v && typeof v === "object" && typeof (v as { file?: unknown }).file === "string";
}

/** Clamp / default an issue's confidence so downstream filters never see NaN. */
function normalizeIssue(issue: Issue): Issue {
	if (typeof issue.confidence === "number" && Number.isFinite(issue.confidence)) {
		return { ...issue, confidence: Math.max(1, Math.min(10, Math.round(issue.confidence))) };
	}
	return { ...issue, confidence: 5 };
}

/** Clamp an externally supplied score (gate re-scores bypass schema paths). */
function clampConfidence(value: unknown): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : 5;
	return Math.max(1, Math.min(10, Math.round(n)));
}

function isCoverage(v: unknown): v is ReviewerOutput["coverage"] {
	return (
		!!v &&
		typeof v === "object" &&
		Array.isArray((v as { filesChecked?: unknown }).filesChecked) &&
		Array.isArray((v as { commandsRun?: unknown }).commandsRun) &&
		Array.isArray((v as { limitations?: unknown }).limitations)
	);
}

function emptyCoverage(): ReviewerOutput["coverage"] {
	return { filesChecked: [], commandsRun: [], limitations: [] };
}

/** Build a deterministic verdict + report from a workflow return value. */
export function runReportTool(input: ReportToolInput): ReportToolResult {
	let rawWorkflowReturn = input.workflowReturn;
	if (typeof rawWorkflowReturn === "string") {
		try {
			rawWorkflowReturn = JSON.parse(rawWorkflowReturn);
		} catch {
			return { ok: false, error: "workflowReturn must be an object or valid JSON string" };
		}
	}
	if (!rawWorkflowReturn || typeof rawWorkflowReturn !== "object") {
		return { ok: false, error: "workflowReturn must be an object" };
	}
	const ret = rawWorkflowReturn as {
		reviewers?: unknown;
		gate?: unknown;
		reviewersShaped?: unknown;
		error?: unknown;
	};
	let reviewersList = Array.isArray(ret.reviewers) ? (ret.reviewers as unknown[]) : [];
	if (reviewersList.length === 0 && ret.error) {
		reviewersList = [{
			key: "execution-error",
			ok: false,
			error: String(ret.error),
			output: undefined,
		}];
	} else if (!Array.isArray(ret.reviewers)) {
		return { ok: false, error: "workflowReturn.reviewers must be an array" };
	}

	// Locate the manifest so the report has authoritative metadata.
	const manifest = loadManifestSafe(input.runId, input.cwd);
	const threshold = input.threshold ?? 8;
	const policy = input.verdictPolicy ?? "strict";

	const reviewersRaw = reviewersList as Array<{
		key: string;
		ok: boolean;
		error?: string;
		structuredOutput?: unknown;
		output?: string;
	}>;
	// Stale-artifact guard: findings may only come from reviewers THIS run
	// fanned out (manifest.reviewerIds). Anything else — e.g. a main agent
	// that reconstructed a workflowReturn from old .pi-subagents artifacts
	// after a failed workflow — is dropped and surfaced, never reported.
	const roster = new Set(manifest?.reviewerIds ?? []);
	const knownReviewers = roster.size === 0
		? reviewersRaw
		: reviewersRaw.filter((r) => roster.has(r.key));
	const unknownKeys = reviewersRaw
		.filter((r) => roster.size > 0 && !roster.has(r.key))
		.map((r) => r.key);
	if (unknownKeys.length > 0 && knownReviewers.length === 0) {
		// Every finding came from outside this run's roster — almost certainly
		// a workflowReturn reconstructed from stale artifacts after a failed
		// workflow. Rendering a report here would fabricate a clean APPROVE
		// over zero real reviewers; refuse instead.
		return {
			ok: false,
			error: `workflowReturn contains no reviewer from this run's roster (got: ${unknownKeys.join(", ")}; roster: ${[...roster].join(", ")}). Findings appear to come from stale artifacts — re-run the review instead of reconstructing its return value.`,
		};
	}
	const reviewerOutputs = knownReviewers.map((r) => ({
		key: r.key,
		ok: r.ok,
		error: r.error,
		output: r.output,
	}));

	const gateRaw = (ret.gate ?? null) as {
		ok: boolean;
		error?: string;
		output?: string;
	} | null;

	// v0.8 data source: the gate (or, in lite mode, the lite-reviewer) ends
	// its Markdown report with one fenced ```json verdict block. That block
	// is the ONLY structured data we machine-read; reviewer Markdown is
	// rendered verbatim for humans and was already arbitrated by the gate.
	const gateMd = gateRaw?.ok ? gateRaw.output : undefined;
	const gateSo = extractVerdictBlock(gateMd);
	const liteSo = gateRaw
		? undefined
		: extractVerdictBlock(reviewerOutputs.find((r) => r.ok)?.output);

	const verdictSource = gateSo ?? liteSo;
	const sourceLabel = gateSo ? "gate" : liteSo ? "lite-reviewer" : null;

	// 1) Candidates come from the verdict block's issues (the gate already
	//    re-scored + verified them). "unverified:" blocker/major dispositions
	//    are exempt from the threshold floor — the verification duty says
	//    those must stay visible instead of dying in a numeric filter.
	const dispoByFp = new Map<string, GateDisposition>();
	for (const d of verdictSource?.dispositions ?? []) dispoByFp.set(d.fingerprint, d);

	const finalCandidates: Array<{ issue: Issue }> = [];
	for (const rawIssue of verdictSource?.issues ?? []) {
		if (!isIssueLike(rawIssue)) continue;
		const issue = normalizeIssue(rawIssue);
		if (!issue.fingerprint) issue.fingerprint = issueFingerprint(issue);
		const d = dispoByFp.get(issue.fingerprint);
		let confidence = issue.confidence;
		let evidence = issue.evidence;
		if (d) {
			confidence = clampConfidence(d.finalConfidence);
			const unverified =
				/^unverified:/i.test(d.reason.trim()) &&
				(issue.severity === "blocker" || issue.severity === "major");
			if (unverified) {
				confidence = Math.max(confidence, threshold);
				evidence = `${evidence} (unverified)`;
			}
		}
		finalCandidates.push({ issue: { ...issue, confidence, evidence } });
	}

	const dedupMap = new Map<string, { issue: Issue }>();
	for (const c of finalCandidates) {
		const key = c.issue.fingerprint ?? issueFingerprint(c.issue);
		const prev = dedupMap.get(key);
		if (!prev || c.issue.confidence > prev.issue.confidence) dedupMap.set(key, c);
	}

	const deduped: Issue[] = [...dedupMap.values()].map((d) => d.issue);
	const enforced = enforceGateOutput({ issues: deduped }, threshold, policy);

	const dispositions: GateDisposition[] = [...dedupMap.values()].map((d) => {
		const fp = d.issue.fingerprint ?? issueFingerprint(d.issue);
		const gateDispo = dispoByFp.get(fp);
		const survived = enforced.issues.some(
			(e) => (e.fingerprint ?? issueFingerprint(e)) === fp,
		);
		return {
			fingerprint: fp,
			decision: survived ? "kept" : "dropped",
			originalConfidence: gateDispo?.originalConfidence ?? d.issue.confidence,
			finalConfidence: d.issue.confidence,
			sourceReviewers: gateDispo?.sourceReviewers ?? [sourceLabel ?? "gate"],
			reason:
				gateDispo?.reason ??
				(survived ? "Survived threshold + dedupe." : "Below threshold or merged."),
		};
	});

	if (!manifest) {
		return {
			ok: false,
			error: `manifest not found for runId ${input.runId}. Has /review prepared the run?`,
		};
	}

	// Effective gate for the report layer: a gate that ran but produced no
	// parseable verdict block counts as no-gate; in lite mode the
	// lite-reviewer's verdict block stands in for the gate.
	const effectiveGate = gateRaw
		? gateSo
			? { ok: true, output: gateMd, structuredOutput: { status: gateSo.status ?? "ok" } }
			: { ok: false, error: gateRaw.error ?? "gate produced no parseable verdict JSON block", output: gateMd }
		: liteSo
			? { ok: true, output: undefined, structuredOutput: { status: liteSo.status ?? "ok" } }
			: null;

	const built = buildReportFromWorkflow({
		startedAt: Date.now(),
		manifest: {
			runId: manifest.runId,
			targetLabel: manifest.targetLabel,
			targetKind: manifest.targetKind,
			prRef: manifest.prRef,
			diffSha256: manifest.diffSha256,
			workspacePath: manifest.workspacePath,
			workspaceHeadSha: manifest.workspaceHeadSha,
			workspaceWarning: manifest.workspaceWarning,
			diffWarning: manifest.diffWarning,
			mode: manifest.mode,
			docsOnly: manifest.docsOnly,
			rulePaths: manifest.rulePaths,
			historyAvailable: manifest.historyAvailable,
			changedFiles: manifest.changedFiles,
			baseSha: manifest.baseSha,
			headSha: manifest.headSha,
			skippedReviewers: manifest.skippedReviewers,
		},
		workflowReturn: { reviewers: reviewerOutputs, gate: effectiveGate },
		threshold,
		policy,
		enforcedVerdict: enforced.verdict,
		enforcedIssues: enforced.issues,
		enforcedDispositions: dispositions,
		enforcedReason: (unknownKeys.length > 0
			? `${enforced.reason} (dropped findings from non-roster reviewer keys: ${unknownKeys.join(", ")})`
			: enforced.reason).slice(0, 500),
	});

	const markdown = renderReport(built);
	// End-of-run reclamation: the report is rendered and persisted, so the
	// plugin-owned scratch clone has no further reader. Only cloned
	// workspaces are touched (never the user's cwd), and each run owns a
	// unique tmpdir root, so concurrent reviews never collide. Runs that
	// never reach this tool (failed workflow) are still caught by the 24h
	// TTL pruner on the next prepareRun.
	if (manifest.workspaceCloned) {
		removeWorkspaceRoot(dirname(manifest.workspacePath));
	}
	return {
		ok: true,
		runId: input.runId,
		verdict: built.verdict,
		markdown,
		report: built,
	};
}

function safeJsonParse(text?: string): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		// The model often wraps the JSON in prose or a fence — try to lift the
		// outermost {...} block out before giving up.
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				const lifted = JSON.parse(text.slice(start, end + 1));
				if (lifted && typeof lifted === "object") return lifted;
			} catch {
				/* not JSON after all */
			}
		}
		return undefined;
	}
}

/**
 * Extract the verdict JSON block from a gate / lite-reviewer Markdown
 * report (v0.8). The report ends with exactly one fenced ```json block;
 * extraction prefers fenced blocks and falls back to brace-lifting.
 * Returns undefined when nothing shaped like { verdict?, issues[] } is
 * found — callers treat that as "no verdict data" (no-gate path).
 */
export function extractVerdictBlock(md?: string):
	| {
			status?: string;
			verdict?: string;
			reason?: string;
			issues?: unknown[];
			dispositions?: GateDisposition[];
			summary?: string;
			coverage?: unknown;
		}
	| undefined {
	if (!md) return undefined;
	const candidates: unknown[] = [];
	const fence = /```(?:json|JSON)?\s*\n([\s\S]*?)```/g;
	let m: RegExpExecArray | null;
	while ((m = fence.exec(md)) !== null) {
		const parsed = safeJsonParse(m[1]!);
		if (parsed && typeof parsed === "object") candidates.push(parsed);
	}
	if (candidates.length === 0) {
		const lifted = safeJsonParse(md);
		if (lifted && typeof lifted === "object") candidates.push(lifted);
	}
	// Prefer the LAST well-shaped block (the verdict block comes at the end;
	// earlier fences may be acceptance reports or examples).
	for (let i = candidates.length - 1; i >= 0; i--) {
		const c = candidates[i] as { issues?: unknown; verdict?: unknown };
		if (Array.isArray(c.issues) || typeof c.verdict === "string") {
			return c as ReturnType<typeof extractVerdictBlock>;
		}
	}
	return undefined;
}

function loadManifestSafe(runId: string, cwd?: string): RunManifest | null {
	// Prefer the explicit run root (tool ctx.cwd); the manifest lives under
	// the same .pi/pi-review/runs/<runId> that prepareRun created.
	const root = cwd?.trim() ? cwd : process.cwd();
	const path = join(root, ".pi", "pi-review", "runs", runId, "manifest.json");
	try {
		const raw = readFileSync(path, "utf-8");
		return JSON.parse(raw) as RunManifest;
	} catch {
		return null;
	}
}

/** Deterministic fingerprint for an issue. */
export function issueFingerprint(issue: Issue): string {
	const line = issue.line === undefined ? "-" : String(issue.line);
	const evHash = simpleHash(issue.evidence);
	return `${issue.file}:${line}:${issue.category}:${evHash}`;
}

function simpleHash(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) {
		h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(36).slice(0, 6);
}