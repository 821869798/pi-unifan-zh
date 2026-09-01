/**
 * Shared type definitions for pi-review (v0.7+).
 *
 * The active path is the foreground workflowScript:
 *   /review → plugin prep (diff + target workspace + manifest)
 *          → main agent runs one subagent({ workflowScript })
 *          → pi_review_report tool renders the deterministic report
 *
 * No legacy spawn-pipeline types remain.
 */

/** Final verdict produced by the code-side gate enforcement. */
export type Verdict = "approve" | "request_changes" | "comment";

/** Issue severity bucket. */
export type IssueSeverity = "blocker" | "major" | "minor" | "nit";

/** Issue category — informs routing and which reviewer surfaced it. */
export type IssueCategory =
	| "compliance"
	| "bug"
	| "convention"
	| "history"
	| "security"
	| "performance"
	| "docs"
	| "other";

/** A single finding reported by a reviewer (or surfaced by the gate). */
export interface Issue {
	/** Repo-relative path, or "global" for cross-cutting findings. */
	file: string;
	/** 1-indexed line in the file. Omit for findings that span ranges or are file-wide. */
	line?: number;
	/** Optional line in the **introduced** diff this finding maps to. */
	relatedChangedLine?: number;
	category: IssueCategory;
	severity: IssueSeverity;
	/** 1-10 confidence score (calibrated like Claude's code-review plugin). */
	confidence: number;
	/** Short evidence quote or paraphrase. Max 280 chars. */
	evidence: string;
	/** Stable id for cross-reviewer dedupe (file:line:category[:short-hash]). */
	fingerprint?: string;
}

/** Per-reviewer status (separate from runtime `ok`/`failed`). */
export type ReviewerStatus = "ok" | "limited" | "skipped" | "failed";

/** Structured payload a reviewer subagent must produce. */
export interface ReviewerOutput {
	status: ReviewerStatus;
	issues: Issue[];
	summary: string;
	coverage: {
		filesChecked: string[];
		commandsRun: string[];
		limitations: string[];
	};
}

/** Per-candidate disposition emitted by the gate for audit. */
export interface GateDisposition {
	fingerprint: string;
	decision: "kept" | "dropped" | "merged";
	originalConfidence: number;
	finalConfidence: number;
	sourceReviewers: string[];
	reason: string;
}

/** Structured payload the gate subagent must produce. */
export interface GateOutput {
	status: ReviewerStatus;
	verdict: Verdict;
	issues: Issue[];
	dispositions: GateDisposition[];
	reason: string;
	coverage: {
		limitations: string[];
	};
}

/** Definition of a single reviewer, loaded from config + bundled prompt. */
export interface ReviewerSpec {
	id: string;
	label: string;
	enabled: boolean;
	/** "inherit" resolves to the parent session model at run time. */
	model: string | "inherit";
	/** Optional per-reviewer thinking level ("off"|"low"|"medium"|"high"|...). */
	thinking?: string;
	/**
	 * Optional absolute path override to the reviewer prompt markdown.
	 * When omitted, the runner derives `agents/<id>.md` from `id`.
	 */
	promptPath?: string;
}

/** Per-run outcome of a single reviewer subagent. */
export interface ReviewerRunResult {
	id: string;
	label: string;
	/** Resolved model id (post-"inherit" substitution). */
	model: string;
	ok: boolean;
	output?: ReviewerOutput;
	error?: string;
	/** Process exit code. null = killed by timeout or signal. undefined = never started. */
	exitCode?: number | null;
	durationMs: number;
}

/** Aggregated verdict produced by the code-side gate enforcement. */
export interface GateVerdict {
	verdict: Verdict;
	/** Deduped + threshold-filtered issues from the reviewer pool. */
	issues: Issue[];
	/** Per-candidate audit trail (kept / dropped / merged). */
	dispositions: GateDisposition[];
	/** Reviewer status reflecting coverage (e.g. "limited" if bugbot failed). */
	status: ReviewerStatus;
	/** One-sentence rationale, max 500 chars. */
	reason: string;
}

/** Per-run outcome of the gate subagent. */
export interface GateRunResult {
	ok: boolean;
	verdict?: GateVerdict;
	error?: string;
	/** Process exit code. null = killed by timeout or signal. undefined = never started. */
	exitCode?: number | null;
	durationMs: number;
	model: string;
}

/** Verdict policy used by the code-side gate enforcement. */
export type VerdictPolicy = "strict" | "legacy";

/** Adaptive routing controls whether obviously-inapplicable lanes are dropped up front. */
export type RoutingMode = "adaptive" | "all";

/** Top-level user-editable config (v0.7). */
export interface PiReviewConfig {
	schemaVersion: 1;
	gate: {
		/** "inherit" → parent session model at run time. */
		model: string | "inherit";
		thinking?: string;
		/** When false, gate is always skipped. */
		enabled: boolean;
		/** Default confidence floor for the gate (issues with confidence < threshold are dropped). */
		threshold: number;
		/** Verdict policy: strict (any blocker/major) | legacy (≥3 majors). */
		verdictPolicy: VerdictPolicy;
	};
	/** Adaptive routing: drop clearly-inapplicable reviewer lanes up front. */
	routing: {
		mode: RoutingMode;
	};
	reviewers: Record<string, Omit<ReviewerSpec, "promptPath"> & { promptPath?: string }>;
	/**
	 * Optional budgets for the foreground directive path (pi-subagents).
	 * turnBudget.maxTurns defaults to 20 (cap 48).
	 */
	budgets?: {
		turnBudget?: { maxTurns?: number; graceTurns?: number };
	};
}

/**
 * What to review — agent-driven (v0.4+). The plugin does **not** embed a full
 * diff; the extension prepares the diff + target workspace, then reviewer
 * children read it.
 */
export type ReviewTargetKind = "pr" | "diff-file" | "local-git";

export interface ReviewTarget {
	kind: ReviewTargetKind;
	/** Short human label for the report header. */
	label: string;
	/** CC-style freeform user context (PR URL, instructions, etc.). */
	userContext?: string;
	/** Parsed PR URL or number when kind === "pr". */
	prRef?: string;
	/** Absolute path to an explicit `--diff` file when kind === "diff-file". */
	diffPath?: string;
	/** Hint for local-git: dirty working tree vs base...HEAD. */
	hint?: string;
	/** Optional short probe note for dry-run. */
	probeNote?: string;
}

/** Top-level run report. */
export interface ReviewReport {
	startedAt: number;
	durationMs: number;
	input: ReviewTarget;
	reviewers: ReviewerRunResult[];
	gate: GateRunResult | null;
	totals: {
		issues: number;
		bySeverity: Record<IssueSeverity, number>;
	};
	verdict: Verdict | "no-gate" | "error" | "partial";
}