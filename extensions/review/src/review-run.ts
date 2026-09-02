/**
 * High-level orchestration for `/review` v0.7:
 *   1. Resolve the ReviewTarget (PR URL / local-git / --diff).
 *   2. Acquire an accurate diff + SHA-256 + changed-files via the plugin's
 *      own `gh`/`git` calls (never re-fetched by reviewers).
 *   3. Prepare a target workspace (clone for PRs, user's cwd for local).
 *   4. Write the run manifest so reviewers + the report tool can read it.
 *   5. Build + emit the directive (now: single `subagent` call followed by
 *      the `pi_review_report` tool).
 *
 * This replaces the old "main agent obtains the diff itself" pattern that
 * silently failed on cross-repo PRs.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_CONFIG, loadConfig, resolveModel } from "./config.js";
import { buildReviewDirective } from "./directive.js";
import { resolveLeanBudgets } from "./lean-agents.js";
import { extractPrRef } from "./pr-ref.js";
import {
	RunManifest,
	WORKSPACE_TTL_MS,
	discoverRulePathsLocal,
	ensureRunDir,
	generateRunId,
	parseChangedFilesFromDiff,
	pruneStaleRuns,
	readManifest,
	resetRunCmd,
	setRunCmd,
	sha256Hex,
	writeDiff,
	writeManifest,
} from "./review-report.js";
import {
	prepareWorkspace,
	removeWorkspaceRoot,
	resetTargetWorkspaceCmd,
	setTargetWorkspaceCmd,
} from "./target-workspace.js";
import type { ReviewTarget } from "./types.js";

export interface PrepareRunInput {
	cwd: string;
	input?: string;
	/** Support `--lite` single-agent mode. */
	lite?: boolean;
	/** Support `--perf` performance & benchmark mode. */
	perf?: boolean;
	/** Support `--full` all 6 reviewers mode. */
	full?: boolean;
	/** Optional per-run gate model override. */
	gateModel?: string;
	/** Set false for dry-runs — pruning is a side effect a dry run must not have. */
	cleanup?: boolean;
}

export interface PreparedRun {
	runId: string;
	manifest: RunManifest;
	directive: string;
	/** Path the main agent will receive as the directive message. */
	directiveText: string;
}

/** Public entrypoint for `index.ts` — prepare a run synchronously. */
export async function prepareRun(input: PrepareRunInput): Promise<PreparedRun | null> {
	const cwd = input.cwd;
	const { config } = loadConfig();
	const target = await resolveReviewTarget(input.cwd, { input: input.input });
	if (!target) return null;

	if (input.cleanup !== false) {
		pruneStaleRuns(cwd);
		pruneLegacyFlatArtifacts(cwd);
		pruneStaleWorkspaces();
	}

	const runId = generateRunId();
	const runDir = ensureRunDir(cwd, runId);

	const diffResult = await acquireDiff(cwd, target, runDir);
	const changedFiles = parseChangedFilesFromDiff(diffResult.diff);
	const rulePaths = discoverRulePathsLocal(cwd);
	// Pass the diff's head SHA so the workspace checkout can verify it landed
	// on the same commit (guards the force-push-between-calls TOCTOU window).
	let workspaceResult = await prepareWorkspace({
		cwd,
		target: { kind: target.kind, prRef: target.prRef, expectedHeadSha: diffResult.headSha },
	});
	if (workspaceResult.cloned && diffResult.headSha && workspaceResult.workspaceHeadSha &&
		workspaceResult.workspaceHeadSha !== diffResult.headSha) {
		// The first clone's scratch root is garbage now — drop it before
		// retrying so a moving PR does not litter tmpdir with depth-50 clones.
		removeWorkspaceRoot(dirname(workspaceResult.workspacePath));
		workspaceResult = await prepareWorkspace({
			cwd,
			target: { kind: target.kind, prRef: target.prRef, expectedHeadSha: diffResult.headSha },
		});
		if (workspaceResult.workspaceHeadSha && workspaceResult.workspaceHeadSha !== diffResult.headSha) {
			throw new Error(
				`pi-review: workspace HEAD ${workspaceResult.workspaceHeadSha.slice(0, 12)} does not match diff head ${diffResult.headSha.slice(0, 12)} — the PR moved during preparation; re-run /review.`,
			);
		}
	}

	const manifest: RunManifest = {
		runId,
		targetLabel: target.label,
		targetKind: target.kind,
		prRef: target.prRef,
		diffPath: diffResult.path,
		diffSha256: sha256Hex(diffResult.diff),
		changedFiles: changedFiles.files,
		docsOnly: changedFiles.docsOnly,
		rulePaths,
		historyAvailable: workspaceResult.historyAvailable,
		mode: diffResult.mode,
		baseSha: diffResult.baseSha,
		headSha: diffResult.headSha,
		mergeBase: diffResult.mergeBase,
		workspacePath: workspaceResult.workspacePath,
		workspaceHeadSha: workspaceResult.workspaceHeadSha,
		workspaceWarning: workspaceResult.warning,
		workspaceCloned: workspaceResult.cloned,
		diffWarning: diffResult.warning,
		runDir,
		createdAt: Date.now(),
	};

	const gateModel = resolveModel(input.gateModel ?? config.gate.model, undefined);
	// Trivial change guard: an empty/placeholder diff (no +/- hunks) is not
	// worth fanning out reviewers. Drop the orphan run dir (only change.diff
	// was written so far) instead of leaving it for the 24h pruner.
	if (changedFiles.additions + changedFiles.deletions === 0) {
		try {
			rmSync(runDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
		return null;
	}
	const profile: ChangeProfile = {
		docsOnly: changedFiles.docsOnly,
		rulePaths,
		historyAvailable: workspaceResult.historyAvailable,
	};
	const isSingle = input.lite || input.perf;
	const reviewers = input.perf
		? [{ id: "perf-review", label: "Performance Review", enabled: true, model: "inherit" }]
		: input.lite
			? [{ id: "lite-review", label: "Lite Review", enabled: true, model: "inherit" }]
			: input.full
				? [
						{ id: "claude-md-compliance", label: "Claude-MD Compliance", enabled: true, model: "inherit" },
						{ id: "bugbot", label: "Bugbot", enabled: true, model: "inherit" },
						{ id: "security-review", label: "Security Review", enabled: true, model: "inherit" },
						{ id: "history-context", label: "History Context", enabled: true, model: "inherit" },
						{ id: "code-comments", label: "Code Comments", enabled: true, model: "inherit" },
						{ id: "perf-review", label: "Performance Review", enabled: true, model: "inherit" },
				  ]
				: reviewersForRouting(target, config, profile);
	const skippedReasons = adaptiveSkips(profile);
	// The report tool uses this to reject findings that did not come from this
	// run's roster (stale-artifact contamination guard).
	manifest.reviewerIds = reviewers.map((r) => r.id);
	const workspacePath = manifest.workspacePath;
	const manifestPath = join(runDir, "manifest.json");
	const diffPath = manifest.diffPath;
	// Raw workflowScript text — the directive embeds it as a template literal
	// and points failed-copy retries at this file (no double-escaping, which
	// used to make the main agent's copy/unescape step error-prone).
	const workflowPath = join(runDir, "workflow.js");
	// Build the directive with real paths inlined (JSON.stringify'd into the
	// workflowScript) — no placeholder + replaceAll substitutions. The old
	// replaceAll injected unquoted paths into the JS template, producing
	// invalid JS (`cwd: /var/folders/...` → SyntaxError).
	const directive = buildReviewDirective({
		target,
		reviewers,
		gateModel,
		gateThinking: isSingle ? undefined : config.gate.thinking,
		gateEnabled: config.gate.enabled,
		threshold: config.gate.threshold,
		verdictPolicy: config.gate.verdictPolicy,
		lite: Boolean(input.lite),
		perf: Boolean(input.perf),
		cwd,
		workspacePath,
		manifestPath,
		diffPath,
		workflowPath,
		budgets: resolveLeanBudgets(config.budgets),
	});
	// Remember which lanes adaptive routing dropped so the report can surface
	// them as coverage rather than letting users wonder where a reviewer went.
	if (!isSingle && config.routing.mode === "adaptive" && skippedReasons.length > 0) {
		const skippedByRouting: Array<{ id: string; reason: string }> = [];
		for (const [id, reason] of skippedReasons) {
			if (!reviewers.some((r) => r.id === id)) skippedByRouting.push({ id, reason });
		}
		manifest.skippedReviewers = skippedByRouting;
	}
	writeManifest(runDir, manifest);

	const directiveText = directive;

	return { runId, manifest, directive, directiveText };
}

/** Read a previously-prepared manifest from disk. */
export function loadManifestFor(cwd: string, runId: string): RunManifest {
	const runDir = join(cwd, ".pi", "pi-review", "runs", runId);
	return readManifest(runDir);
}

/* ------------------------------------------------------------------ */
/* Diff acquisition — replaces `src/obtain-diff.ts`'s bash block.     */
/* ------------------------------------------------------------------ */

interface DiffAcquisitionResult {
	path: string;
	diff: string;
	mode: RunManifest["mode"];
	baseSha?: string;
	headSha?: string;
	mergeBase?: string;
	warning?: string;
}

async function acquireDiff(
	cwd: string,
	target: ReviewTarget,
	runDir: string,
): Promise<DiffAcquisitionResult> {
	if (target.kind === "pr" && target.prRef) {
		return acquirePrDiff(cwd, target.prRef, runDir);
	}
	if (target.kind === "diff-file" && target.diffPath) {
		const text = safeRead(target.diffPath);
		const path = writeDiff(runDir, text);
		return { path, diff: text, mode: "local-uncommitted" };
	}
	return acquireLocalDiff(cwd, runDir);
}

async function acquirePrDiff(
	cwd: string,
	prRef: string,
	runDir: string,
): Promise<DiffAcquisitionResult> {
	// Metadata first (base/head SHAs feed the manifest + workspace checkout
	// reconciliation). A failed view is non-fatal — the diff below is the
	// authority, not the metadata.
	const gh = await _runCmd(
		"gh",
		["pr", "view", prRef, "--json", "number,baseRefName,baseRefOid,headRefOid,headRepository,headRepositoryOwner"],
		{ cwd },
	);
	let prMeta: {
		number?: string;
		baseRefName?: string;
		baseRefOid?: string;
		headRefOid?: string;
		headRepository?: { name?: string };
		headRepositoryOwner?: { login?: string };
	} | null = null;
	if (gh.exitCode === 0 && gh.stdout.trim()) {
		try {
			prMeta = JSON.parse(gh.stdout);
		} catch {
			prMeta = null;
		}
	}

	// `gh pr diff` is the SINGLE diff authority: it is byte-for-byte what the
	// GitHub web UI renders for the PR (same base/merge-base semantics). A
	// locally computed `git diff origin/main...FETCH_HEAD` can diverge from
	// that (different merge-base, ref timing), which is exactly the
	// "diff does not match GitHub" failure class — so we never substitute our
	// own computation. On failure we stop and tell the user to fix gh.
	const ghDiff = await _runCmd("gh", ["pr", "diff", prRef], { cwd });
	if (ghDiff.exitCode !== 0) {
		throw new Error(
			`pi-review: gh pr diff failed for ${prRef} (${ghDiff.stderr.trim().slice(0, 200)}). gh pr diff is the single diff authority (it matches the GitHub web UI exactly), so there is no local fallback — check gh auth/install and re-run. Details: ${ghDiff.stdout.trim().slice(0, 200)}`,
		);
	}
	const path = writeDiff(runDir, ghDiff.stdout);
	return {
		path,
		diff: ghDiff.stdout,
		mode: "gh-pr-diff",
		baseSha: prMeta?.baseRefOid,
		headSha: prMeta?.headRefOid,
	};
}

async function acquireLocalDiff(cwd: string, runDir: string): Promise<DiffAcquisitionResult> {
	const status = await _runCmd("git", ["status", "--porcelain"], { cwd });
	if (status.stdout.trim().length > 0) {
		// Mixed trees (modified + untracked files) must review BOTH parts —
		// new files are exactly what needs eyes. Combine the tracked diff
		// with synthesized new-file diffs instead of returning early on the
		// first non-empty piece.
		const tracked = (await _runCmd("git", ["diff", "HEAD"], { cwd })).stdout;
		const untracked = (await _runCmd("git", ["ls-files", "--others", "--exclude-standard"], { cwd })).stdout;
		const untrackedParts: string[] = [];
		for (const f of untracked.trim() ? untracked.trim().split("\n") : []) {
			try {
				const buf = readFileSync(join(cwd, f));
				// NUL in the leading bytes marks a binary file — utf-8 coercion
				// would turn it into megabytes of U+FFFD noise.
				if (buf.subarray(0, 8000).includes(0)) {
					untrackedParts.push(`diff --git a/${f} b/${f}\nnew file mode 100644\nBinary file ${f} added (contents not shown)\n`);
					continue;
				}
				const lines = buf.toString("utf-8").split("\n");
				untrackedParts.push(
					`diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`,
				);
			} catch {
				/* unreadable (permission / deleted race) — skip */
			}
		}
		const text = [tracked.trim(), ...untrackedParts].filter(Boolean).join("\n");
		if (text) {
			const path = writeDiff(runDir, text);
			return { path, diff: text, mode: "local-uncommitted", headSha: await safeRev(cwd, "HEAD") };
		}
	}

	const base = await detectDefaultBranch(cwd);
	if (!base) {
		const placeholder = `(no diff captured: clean tree, no default branch detected)\n`;
		const path = writeDiff(runDir, placeholder);
		return { path, diff: placeholder, mode: "local-vs-default" };
	}
	const baseFetch = await _runCmd("git", ["fetch", "origin", base, "--quiet"], { cwd });
	// A failed fetch with an existing remote-tracking ref silently diffs
	// against a stale base — surface it instead (the local twin of the PR
	// stale-ref incident; kept non-fatal because offline local review is a
	// legitimate mode and the manifest records whichever base was used).
	let diffWarning: string | undefined;
	if (baseFetch.exitCode !== 0) {
		const hasRemoteRef = (await _runCmd("git", ["rev-parse", "--verify", `refs/remotes/origin/${base}`], { cwd })).exitCode === 0;
		if (hasRemoteRef) {
			diffWarning = `git fetch origin ${base} failed — diffing against possibly-stale origin/${base}`;
		}
	}
	const compare = (await _runCmd("git", ["rev-parse", "--verify", `origin/${base}`], { cwd })).exitCode === 0
		? `origin/${base}`
		: base;
	const diff = await _runCmd("git", ["diff", `${compare}...HEAD`], { cwd });
	const text = diff.stdout.length > 0 ? diff.stdout : `(no diff vs ${compare})\n`;
	const path = writeDiff(runDir, text);
	return {
		path,
		diff: text,
		mode: "local-vs-default",
		baseSha: await safeRev(cwd, compare),
		headSha: await safeRev(cwd, "HEAD"),
		mergeBase: (await _runCmd("git", ["merge-base", compare, "HEAD"], { cwd })).stdout.trim() || undefined,
		warning: diffWarning,
	};
}

async function safeRev(cwd: string, ref: string): Promise<string | undefined> {
	const r = await _runCmd("git", ["rev-parse", ref], { cwd });
	if (r.exitCode !== 0) return undefined;
	return r.stdout.trim() || undefined;
}

async function detectDefaultBranch(cwd: string): Promise<string | null> {
	const sym = await _runCmd("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd });
	if (sym.exitCode === 0) {
		const v = sym.stdout.trim();
		return v.startsWith("origin/") ? v.slice("origin/".length) : v;
	}
	for (const candidate of ["main", "master"]) {
		const probe = await _runCmd("git", ["rev-parse", "--verify", `refs/heads/${candidate}`], { cwd });
		if (probe.exitCode === 0) return candidate;
	}
	const head = await _runCmd("git", ["symbolic-ref", "--short", "HEAD"], { cwd });
	if (head.exitCode === 0) return head.stdout.trim();
	return null;
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

let _runCmd: (cmd: string, args: string[], opts: { cwd: string }) => Promise<CmdResult>;
async function defaultRunCmd(
	cmd: string,
	args: string[],
	opts: { cwd: string },
): Promise<CmdResult> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolve) => {
		try {
			const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout?.setEncoding("utf-8");
			child.stderr?.setEncoding("utf-8");
			child.stdout?.on("data", (d: string) => (stdout += d));
			child.stderr?.on("data", (d: string) => (stderr += d));
			child.on("error", () => resolve({ stdout, stderr, exitCode: 1 }));
			child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
		} catch {
			resolve({ stdout: "", stderr: "spawn failed", exitCode: 1 });
		}
	});
}
_runCmd = defaultRunCmd;

/** Tests inject a fake. */
export function setReviewRunCmd(fn: (cmd: string, args: string[], opts: { cwd: string }) => Promise<CmdResult>): void {
	_runCmd = fn;
}
export function resetReviewRunCmd(): void {
	_runCmd = defaultRunCmd;
}

/* ------------------------------------------------------------------ */
/* Reviewer roster — adaptive routing based on target / change-kind.  */
/* ------------------------------------------------------------------ */

import type { PiReviewConfig, ReviewerSpec } from "./types.js";

export interface ChangeProfile {
	docsOnly: boolean;
	rulePaths: string[];
	historyAvailable: boolean;
}

/**
 * Select enabled reviewers, then — in `adaptive` mode — drop lanes that
 * cannot add signal for THIS change:
 *  - no rule files          → skip claude-md-compliance
 *  - docs-only diff         → skip bugbot / security-review (no code to scan)
 *  - no git history         → skip history-context
 *  - docs-only              → skip code-comments (nothing but prose touched)
 *
 * The directive still tells reviewer children to return `status: skipped`
 * for these conditions when running in `routing.mode = "all"`, so coverage
 * stays honest even when the lane cannot run.
 */
export function reviewersForRouting(
	target: ReviewTarget,
	config: PiReviewConfig,
	profile?: ChangeProfile,
): ReviewerSpec[] {
	const all = Object.values(config.reviewers).filter((r) => r.enabled);
	if (config.routing.mode !== "adaptive" || !profile) return all;

	const skippedReasons = adaptiveSkips(profile);
	if (skippedReasons.length === 0) return all;

	const reasons = new Map(skippedReasons);
	return all.filter((r) => !reasons.has(r.id));
}

/** Return reviewer-id → reason for every lane that adaptive mode should drop. */
export function adaptiveSkips(profile: ChangeProfile): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	if (profile.rulePaths.length === 0) {
		out.push(["claude-md-compliance", "no rule files (AGENTS.md / CLAUDE.md / .pi rules)"]);
	}
	if (profile.docsOnly) {
		out.push(["bugbot", "docs-only change (no code to scan)"]);
		out.push(["security-review", "docs-only change (no code to scan)"]);
		out.push(["code-comments", "docs-only change (no inline comments to violate)"]);
	}
	if (!profile.historyAvailable) {
		out.push(["history-context", "no git history available in the target workspace"]);
	}
	return out;
}

function safeRead(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

/**
 * One-time-per-run回收 of the v0.5/0.6 flat layout (`.pi/pi-review/*.txt`
 * + `change.diff` at the root). Those leftovers were repeatedly misread as
 * the current run's inputs by later sessions; only known legacy filenames
 * directly under `.pi/pi-review/` are touched — `runs/` is never scanned.
 */
export function pruneLegacyFlatArtifacts(cwd: string): string[] {
	const root = join(cwd, ".pi", "pi-review");
	const legacyNames = ["change.diff", "changed-files.txt", "change-kind.txt", "diff-meta.txt"];
	const removed: string[] = [];
	for (const name of legacyNames) {
		const p = join(root, name);
		try {
			if (existsSync(p)) {
				rmSync(p, { force: true });
				removed.push(p);
			}
		} catch {
			/* best effort */
		}
	}
	return removed;
}

/** Prune scratch workspace clones older than WORKSPACE_TTL_MS from the tmpdir. */
export function pruneStaleWorkspaces(now = Date.now()): string[] {
	const removed: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(tmpdir());
	} catch {
		return removed;
	}
	for (const entry of entries) {
		if (!entry.startsWith("pi-review-ws-")) continue;
		const path = join(tmpdir(), entry);
		try {
			const stat = statSync(path);
			if (now - stat.mtimeMs > WORKSPACE_TTL_MS) {
				rmSync(path, { recursive: true, force: true });
				removed.push(path);
			}
		} catch {
			/* already gone or unreadable */
		}
	}
	return removed;
}

/** Resolve a ReviewTarget locally (mirrors src/git-input.ts without the `gh pr diff` call). */
async function resolveReviewTarget(
	cwd: string,
	opts: { input?: string },
): Promise<ReviewTarget | null> {
	const userContext = opts.input?.trim() || undefined;
	const prRef = userContext ? extractPrRef(userContext) : null;
	if (prRef) {
		return {
			kind: "pr",
			label: prLabel(prRef),
			userContext,
			prRef,
			hint: `Obtain PR ${prRef} yourself via gh and/or git. The plugin already prepared the target repo + diff.`,
		};
	}
	const git = await _runCmd("git", ["rev-parse", "--git-dir"], { cwd }).then((r) => r.exitCode === 0);
	if (!git) return null;
	const status = await _runCmd("git", ["status", "--porcelain"], { cwd });
	const dirty = status.stdout.trim().length > 0;
	const base = await detectDefaultBranch(cwd);
	const baseHint = base ?? "main";
	if (dirty) {
		return {
			kind: "local-git",
			label: "uncommitted changes",
			userContext,
			hint: "Working tree is dirty.",
		};
	}
	return {
		kind: "local-git",
		label: `vs ${baseHint}`,
		userContext,
		hint: `Working tree is clean. Diff vs ${baseHint} is already prepared.`,
	};
}

function prLabel(prRef: string): string {
	const n = prRef.match(/pull\/(\d+)/i)?.[1] ?? prRef.replace(/^#/, "");
	return `PR ${n}`;
}

// Re-exports for tests
export { setRunCmd, resetRunCmd, setTargetWorkspaceCmd, resetTargetWorkspaceCmd };

void DEFAULT_CONFIG;
void writeFileSync;