/**
 * Configuration loading, validation, and atomic persistence (v0.7).
 *
 * The user-editable config lives at:
 *   ~/.pi/agent/extensions/pi-review/config.json
 *
 * Pattern mirrors pi-subagents/src/extension/config.ts. We never touch the
 * top-level settings.json — that file is managed by pi itself.
 *
 * v0.7 removes configuration knobs that the foreground workflowScript path
 * cannot honor (per-reviewer `tools`, `inheritance`, `gate.scorePerIssue`,
 * top-level `concurrency`). Legacy keys are still read for migration
 * warnings but no longer drive behavior.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LEAN_BUDGETS } from "./lean-agents.js";
import type { PiReviewConfig, ReviewerSpec, RoutingMode, VerdictPolicy } from "./types.js";

/**
 * Cheap model used by default for the gate (dedupe + re-score + verdict).
 * The gate is pure de-noise reasoning, so it defaults to a cheap tier;
 * reviewers stay on "inherit" to follow the parent session's stronger model.
 * Override via config.json (`gate.model`) or `--gate-model`.
 */
export const DEFAULT_GATE_MODEL = "anthropic/claude-haiku-4-5";

/** Default reviewer and gate config shipped with the package (v0.7). */
export const DEFAULT_CONFIG: PiReviewConfig = {
	schemaVersion: 1,
	gate: {
		model: DEFAULT_GATE_MODEL,
		thinking: "low",
		enabled: true,
		threshold: 8,
		verdictPolicy: "strict",
	},
	routing: {
		mode: "adaptive",
	},
	reviewers: {
		"claude-md-compliance": {
			id: "claude-md-compliance",
			label: "Claude-MD Compliance",
			enabled: true,
			model: "inherit",
		},
		bugbot: {
			id: "bugbot",
			label: "Bugbot",
			enabled: true,
			model: "inherit",
		},
		"history-context": {
			id: "history-context",
			label: "History Context",
			enabled: true,
			model: "inherit",
		},
		"security-review": {
			id: "security-review",
			label: "Security Review",
			enabled: true,
			model: "inherit",
		},
		"code-comments": {
			id: "code-comments",
			label: "Code Comments",
			enabled: true,
			model: "inherit",
		},
		conventions: {
			id: "conventions",
			label: "Conventions",
			enabled: false,
			model: "inherit",
		},
	},
	// No budgets override by default — lean-agents' LEAN_BUDGETS owns the
	// defaults (26 turns); a stale hard-coded 20 here would silently regress
	// them whenever config was wired through.
};

/**
 * Canonical config file path — top-level beside `permission-modes.json`,
 * `settings.json`, etc. (mirrors pi-permission-modes), so it is easy to find.
 * Tests override it via `setConfigPath` to point at a sandbox.
 */
const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-review.json");
let _configPath = DEFAULT_CONFIG_PATH;

export function configPath(): string {
	return _configPath;
}

/** Override the config path (used by tests). Pass nothing to reset to default. */
export function setConfigPath(p?: string): void {
	_configPath = p ?? DEFAULT_CONFIG_PATH;
}

/**
 * Read raw config from disk. Returns an empty object when the file is
 * missing, unreadable, or corrupt — the caller is expected to fall through
 * to mergeWithDefaults().
 */
export function loadRawConfig(): Record<string, unknown> {
	const path = configPath();
	if (!existsSync(path)) return {};
	try {
		const text = readFileSync(path, "utf-8");
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

/** Legacy config keys that no longer drive behavior (migration warning only). */
export const LEGACY_CONFIG_KEYS = [
	"concurrency",
	"inheritance",
	"gate.scorePerIssue",
	"reviewers.<id>.tools",
	"reviewers.<id>.timeoutMs",
] as const;

/** Detect legacy keys in a raw config and return human-readable warnings. */
export function legacyConfigWarnings(raw: Record<string, unknown>): string[] {
	const warnings: string[] = [];
	if ("concurrency" in raw) {
		warnings.push("concurrency is no longer used (workflowScript runs all reviewers in parallel).");
	}
	if ("inheritance" in raw) {
		warnings.push("inheritance is no longer used (agent tools come from agent frontmatter).");
	}
	const gate = raw.gate as Record<string, unknown> | undefined;
	if (gate && "scorePerIssue" in gate) {
		warnings.push("gate.scorePerIssue is no longer used (gate re-scores within its single pass).");
	}
	const reviewers = raw.reviewers as Record<string, unknown> | undefined;
	if (reviewers && typeof reviewers === "object") {
		for (const [id, ov] of Object.entries(reviewers)) {
			if (!ov || typeof ov !== "object" || Array.isArray(ov)) continue;
			const o = ov as Record<string, unknown>;
			if ("tools" in o) warnings.push(`reviewers.${id}.tools is no longer used (tools come from agent frontmatter).`);
			if ("timeoutMs" in o) warnings.push(`reviewers.${id}.timeoutMs is no longer used; use budgets.turnBudget.`);
		}
	}
	return warnings;
}

/**
 * Deep-merge a raw user config over DEFAULT_CONFIG. We deliberately re-build
 * nested objects rather than mutating so the merge is pure.
 */
export function mergeWithDefaults(raw: unknown): PiReviewConfig {
	const base: PiReviewConfig = structuredClone(DEFAULT_CONFIG);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
	const r = raw as Record<string, unknown>;

	if (typeof r.schemaVersion === "number") {
		base.schemaVersion = r.schemaVersion as 1;
	}

	// Gate block.
	if (r.gate && typeof r.gate === "object" && !Array.isArray(r.gate)) {
		const g = r.gate as Record<string, unknown>;
		if (typeof g.model === "string") base.gate.model = g.model;
		if (typeof g.thinking === "string") base.gate.thinking = g.thinking;
		if (typeof g.enabled === "boolean") base.gate.enabled = g.enabled;
		if (typeof g.threshold === "number" && Number.isFinite(g.threshold)) {
			base.gate.threshold = clampThreshold(g.threshold);
		}
		if (typeof g.verdictPolicy === "string") {
			const vp = parseVerdictPolicy(g.verdictPolicy);
			if (vp) base.gate.verdictPolicy = vp;
		}
		// Legacy: `scorePerIssue` ignored with a migration warning (see
		// legacyConfigWarnings). Explicitly dropped here so it cannot leak.
	}

	// Routing block.
	if (r.routing && typeof r.routing === "object" && !Array.isArray(r.routing)) {
		const rt = r.routing as Record<string, unknown>;
		if (typeof rt.mode === "string") {
			const mode = parseRoutingMode(rt.mode);
			if (mode) base.routing.mode = mode;
		}
	}

	// Reviewer overrides — keyed by id. tools/timeoutMs are ignored (legacy).
	if (r.reviewers && typeof r.reviewers === "object" && !Array.isArray(r.reviewers)) {
		const reviewers = r.reviewers as Record<string, unknown>;
		for (const [id, rawR] of Object.entries(reviewers)) {
			if (!rawR || typeof rawR !== "object" || Array.isArray(rawR)) continue;
			const ov = rawR as Record<string, unknown>;
			const existing = base.reviewers[id];
			const merged: ReviewerSpec = existing
				? { ...existing, id, label: existing.label }
				: { id, label: id, enabled: true, model: "inherit" };
			if (typeof ov.label === "string") merged.label = ov.label;
			if (typeof ov.enabled === "boolean") merged.enabled = ov.enabled;
			if (typeof ov.model === "string") merged.model = ov.model;
			if (typeof ov.thinking === "string") merged.thinking = ov.thinking;
			if (typeof ov.promptPath === "string") merged.promptPath = ov.promptPath;
			base.reviewers[id] = merged;
		}
	}

	// Optional budgets (directive path). The empty-object fallback mirrors
	// lean-agents' defaults — a hard-coded 20 here would silently regress the
	// 26-turn default whenever a user wrote `budgets: {}`.
	if (r.budgets && typeof r.budgets === "object" && !Array.isArray(r.budgets)) {
		const b = r.budgets as Record<string, unknown>;
		base.budgets = base.budgets ?? {
			turnBudget: { maxTurns: LEAN_BUDGETS.turnBudget.maxTurns, graceTurns: LEAN_BUDGETS.turnBudget.graceTurns },
		};
		if (b.turnBudget && typeof b.turnBudget === "object" && !Array.isArray(b.turnBudget)) {
			const tb = b.turnBudget as Record<string, unknown>;
			base.budgets.turnBudget = {
				...base.budgets.turnBudget,
				...(typeof tb.maxTurns === "number" && Number.isFinite(tb.maxTurns)
					? { maxTurns: Math.max(1, Math.min(48, Math.floor(tb.maxTurns))) }
					: {}),
				...(typeof tb.graceTurns === "number" && Number.isFinite(tb.graceTurns)
					? { graceTurns: Math.max(0, Math.floor(tb.graceTurns)) }
					: {}),
			};
		}
	}

	return base;
}

/** Threshold is 0-10 inclusive; values outside are clamped. NaN falls back to 8 (default). */
export function clampThreshold(n: number): number {
	if (Number.isNaN(n)) return 8;
	if (n === Infinity) return 10;
	if (n === -Infinity) return 0;
	if (!Number.isFinite(n)) return 8;
	return Math.max(0, Math.min(10, Math.floor(n)));
}

export function parseVerdictPolicy(raw: string): VerdictPolicy | null {
	const v = raw.trim().toLowerCase();
	if (v === "strict" || v === "legacy") return v;
	return null;
}

export function parseRoutingMode(raw: string): RoutingMode | null {
	const v = raw.trim().toLowerCase();
	if (v === "adaptive" || v === "all") return v;
	return null;
}

/**
 * Validate a merged config. Returns ok=false with a list of human-readable
 * errors when something is wrong. Used by /review-config to surface bad edits.
 */
export function validateConfig(cfg: PiReviewConfig): { ok: true } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (cfg.schemaVersion !== 1) {
		errors.push(`schemaVersion must be 1 (got ${String(cfg.schemaVersion)})`);
	}
	if (cfg.gate.model !== "inherit" && typeof cfg.gate.model !== "string") {
		errors.push("gate.model must be a string or 'inherit'");
	}
	if (cfg.gate.model === "") {
		errors.push("gate.model cannot be an empty string");
	}
	if (cfg.gate.threshold < 0 || cfg.gate.threshold > 10) {
		errors.push("gate.threshold must be between 0 and 10");
	}
	if (cfg.gate.verdictPolicy !== "strict" && cfg.gate.verdictPolicy !== "legacy") {
		errors.push("gate.verdictPolicy must be strict | legacy");
	}
	if (cfg.routing.mode !== "adaptive" && cfg.routing.mode !== "all") {
		errors.push("routing.mode must be adaptive | all");
	}
	for (const [id, r] of Object.entries(cfg.reviewers)) {
		if (r.model !== "inherit" && typeof r.model !== "string") {
			errors.push(`reviewers.${id}.model must be a string or 'inherit'`);
		}
		if (r.model === "") {
			errors.push(`reviewers.${id}.model cannot be an empty string`);
		}
	}
	return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Atomic write: tmp file + rename. Mirrors pi-effort/effort.ts:201-218. */
export function writeConfig(cfg: PiReviewConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	try {
		writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		throw err;
	}
}

/**
 * Read → merge → validate in one call. Returns the effective config plus any
 * validation issues. When validation fails, the function still returns the
 * merged config (best-effort) so the caller can decide whether to proceed.
 */
export function loadConfig(): { config: PiReviewConfig; errors: string[]; legacyWarnings: string[] } {
	const raw = loadRawConfig();
	const config = mergeWithDefaults(raw);
	const validation = validateConfig(config);
	return {
		config,
		errors: validation.ok ? [] : validation.errors,
		legacyWarnings: legacyConfigWarnings(raw),
	};
}

/**
 * Resolve the "inherit" sentinel against a real model id. Falls back to a
 * sensible default when the parent session has no model (e.g. RPC mode).
 */
export function resolveModel(value: string | "inherit", parentModelId: string | undefined): string {
	if (value === "inherit") {
		return parentModelId && parentModelId.length > 0
			? parentModelId
			: DEFAULT_GATE_MODEL;
	}
	return value;
}