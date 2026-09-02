/**
 * Mapping from pi-review reviewer ids → pi-subagents runtime agent names,
 * plus per-child budgets for the token-lean workflowScript directive path.
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
	/** Per-child turn budget, injected onto each runs.all / runs.run child item. */
	turnBudget: { maxTurns: number; graceTurns: number };
	/** Per-child tool budget for the default reviewer (injected per runs.all item). */
	defaultToolBudget: ToolBudgetSpec;
	/** Stricter per-child tool budget for history-context (injected per runs.all item). */
	historyToolBudget: ToolBudgetSpec;
	/** Ultra-lean tool budget for lite-review. */
	liteToolBudget: ToolBudgetSpec;
	/** Gate child budgets (injected onto the runs.run("gate", ...) item). */
	gateTurnBudget: { maxTurns: number; graceTurns: number };
	gateToolBudget: ToolBudgetSpec;
	/** Wall-clock timeout for the top-level workflowScript call (ms). */
	timeoutMs: number;
}

export const LEAN_BUDGETS: LeanBudgetSpec = {
	turnBudget: { maxTurns: 8, graceTurns: 1 },
	defaultToolBudget: { soft: 6, hard: 10 },
	historyToolBudget: { soft: 4, hard: 6 },
	liteToolBudget: { soft: 3, hard: 5 },
	gateTurnBudget: { maxTurns: 6, graceTurns: 1 },
	gateToolBudget: { soft: 6, hard: 10 },
	timeoutMs: 600_000,
};

export function toolBudgetForReviewer(id: string): ToolBudgetSpec {
	if (id === "lite-review") return LEAN_BUDGETS.liteToolBudget;
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
 * Shared false-positive list in Chinese.
 */
export const FALSE_POSITIVE_GUIDANCE = [
	"本次改动未触及的历史遗留代码问题",
	"资深工程师不会指出的吹毛求疵风格琐碎建议",
	"Linter、类型检查器或 CI 构建会自动捕获的问题",
	"泛泛的代码质量建议（如建议补单测或文档），除非项目规则明确强制要求",
	"表面看似 Bug 但实际属于本次改动预期特性的行为",
].join("; ");