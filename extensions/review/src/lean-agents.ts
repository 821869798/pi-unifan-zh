/**
 * Mapping from pi-review reviewer ids → pi-subagents runtime agent names,
 * plus per-child budgets for the token-lean workflowScript directive path.
 *
 * Agents live in `agents/*.md` and are registered via package.json
 * `pi.subagents.agents` so pi-subagents discovers them as package agents
 * (`pi-review.<id>`).
 *
 * Budget model (pi-subagents ≥0.41 workflowScript API): the top-level
 * `subagent({ workflowScript })` call carries `context`/`timeoutMs` only;
 * `turnBudget` and per-reviewer `toolBudget` are injected onto each
 * `runs.all` / `runs.run` child item (child params override workflow
 * defaults). `runs.run` rejects `tasks`/`chain`/`concurrency` but accepts
 * `toolBudget`/`turnBudget`/`model`/`output`.
 */

export const LEAN_AGENT_PACKAGE = "pi-review";

/** Runtime agent name for a reviewer id (e.g. bugbot → pi-review.bugbot). */
export function leanAgentName(reviewerId: string): string {
	return `${LEAN_AGENT_PACKAGE}.${reviewerId}`;
}

/** Gate agent runtime name. */
export const LEAN_GATE_AGENT = leanAgentName("gate");

export interface ToolBudgetSpec {
	soft: number;
	hard: number;
}

export interface LeanBudgetSpec {
	/** Per-child turn budget, injected onto each runs.all / runs.run item. */
	turnBudget: { maxTurns: number; graceTurns: number };
	/** Per-child tool budget for the default reviewer (injected per runs.all item). */
	defaultToolBudget: ToolBudgetSpec;
	/** Stricter per-child tool budget for history-context (injected per runs.all item). */
	historyToolBudget: ToolBudgetSpec;
	/** Gate child budgets (injected onto the runs.run("gate", ...) item). */
	gateTurnBudget: { maxTurns: number; graceTurns: number };
	gateToolBudget: ToolBudgetSpec;
	/** Wall-clock timeout for the top-level workflowScript call (ms). */
	timeoutMs: number;
}

/**
 * Defaults (v0.7.1): reviewers 20→26 turns (field runs kept wrapping up
 * partial at 20); the gate 6→16 turns / 5→14 soft tools — it now carries a
 * verification duty on high-severity candidates (read the diff hunk + the
 * touched file) and physically could not verify anything under the old
 * budget. Wall clock 10→17 min to match.
 */
export const LEAN_BUDGETS: LeanBudgetSpec = {
	turnBudget: { maxTurns: 26, graceTurns: 2 },
	defaultToolBudget: { soft: 20, hard: 32 },
	historyToolBudget: { soft: 14, hard: 24 },
	gateTurnBudget: { maxTurns: 16, graceTurns: 2 },
	gateToolBudget: { soft: 14, hard: 20 },
	timeoutMs: 1_000_000,
};

export function toolBudgetForReviewer(id: string): ToolBudgetSpec {
	if (id === "history-context") return LEAN_BUDGETS.historyToolBudget;
	return LEAN_BUDGETS.defaultToolBudget;
}

/** Merge optional config.budgets.turnBudget over defaults. */
export function resolveLeanBudgets(override?: {
	turnBudget?: { maxTurns?: number; graceTurns?: number };
}): LeanBudgetSpec {
	const base = { ...LEAN_BUDGETS, turnBudget: { ...LEAN_BUDGETS.turnBudget } };
	if (override?.turnBudget?.maxTurns != null && override.turnBudget.maxTurns >= 1) {
		base.turnBudget.maxTurns = Math.min(48, Math.floor(override.turnBudget.maxTurns));
	}
	if (override?.turnBudget?.graceTurns != null && override.turnBudget.graceTurns >= 0) {
		base.turnBudget.graceTurns = Math.floor(override.turnBudget.graceTurns);
	}
	return base;
}

/** Append :thinking to a model id when thinking is set (gate path). */
export function withThinkingSuffix(model: string, thinking?: string): string {
	if (!thinking || thinking === "off" || thinking === "false") return model;
	const colon = model.lastIndexOf(":");
	const known = ["minimal", "low", "medium", "high", "xhigh", "max", "min"];
	if (colon !== -1 && known.includes(model.slice(colon + 1))) {
		return `${model.slice(0, colon)}:${thinking}`;
	}
	return `${model}:${thinking}`;
}

/**
 * Shared false-positive list (injected once into the directive).
 * Wording constraint: this text is embedded verbatim in the gate task, which
 * pi-subagents classifies for read-only vs implementation intent — keep it
 * free of bare write verbs (modify/edit/implement/…) outside explicit
 * prohibitions, or the read-only gate gets rejected at launch.
 */
export const FALSE_POSITIVE_GUIDANCE = [
	"Pre-existing issues on lines untouched by this change",
	"Pedantic nitpicks a senior engineer would not call out",
	"Issues a linter, typechecker, or CI would catch",
	"Generic quality (missing tests/docs) unless a project rule explicitly requires it",
	"Something that looks like a bug but is intentional given the change",
].join("; ");
