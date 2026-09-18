import type { WorkflowStateResult } from "./workflow-state.js";
import type { WorkStatus } from "../driver/work-loop-driver.js";

export interface WorkflowStepItem {
	number: string;
	id: "01-brainstorm" | "02-plan" | "03-work" | "04-review" | "05-learn";
	title: string;
	status: "completed" | "in_progress" | "ready" | "pending" | "idle";
	statusLabel: string;
	detail: string;
	isCurrent: boolean;
}

/**
 * Generates an ASCII progress bar, e.g. [██████░░░░░░░░░░] 38%
 */
export function renderProgressBar(completed: number, total: number, barLength = 12): string {
	if (total <= 0) return "░".repeat(barLength);
	const ratio = Math.min(1, Math.max(0, completed / total));
	const filled = Math.round(ratio * barLength);
	const empty = barLength - filled;
	return "█".repeat(filled) + "░".repeat(empty);
}

/**
 * Derives the full 5-step status array from workflow state and driver status.
 */
export function deriveWorkflowSteps(
	state: WorkflowStateResult,
	workStatus: WorkStatus,
): WorkflowStepItem[] {
	// Determine current active step
	let currentStepId: WorkflowStepItem["id"] = state.recommendedSkill || "01-brainstorm";
	if (workStatus.isActive) {
		currentStepId = "03-work";
	}

	const steps: WorkflowStepItem[] = [];

	// Step 01: 01-brainstorm
	const hasBrainstorm = state.brainstorms.length > 0;
	steps.push({
		number: "01",
		id: "01-brainstorm",
		title: "需求发现与规格说明",
		status: hasBrainstorm ? "completed" : "ready",
		statusLabel: hasBrainstorm ? "[已完成]" : "[就绪]",
		detail: hasBrainstorm
			? `${state.brainstorms.length} 个需求文档 (最新: ${state.latestBrainstorm?.filename || "-"})`
			: "建议梳理目标、边界与成功标准",
		isCurrent: currentStepId === "01-brainstorm",
	});

	// Step 02: 02-plan
	const hasPlan = state.plans.length > 0;
	steps.push({
		number: "02",
		id: "02-plan",
		title: "架构设计与TDD计划",
		status: hasPlan ? "completed" : hasBrainstorm ? "ready" : "pending",
		statusLabel: hasPlan ? "[已完成]" : hasBrainstorm ? "[就绪]" : "[待办]",
		detail: hasPlan
			? `${state.plans.length} 个计划文档 (最新: ${state.latestPlan?.filename || "-"})`
			: hasBrainstorm
				? "可基于需求拆解架构与 TDD 实施单元"
				: "待梳理需求文档",
		isCurrent: currentStepId === "02-plan",
	});

	// Step 03: 03-work
	const totalUnits = state.totalUnitsCount ?? workStatus.allUnits.length;
	const completedUnits = state.completedUnitsCount ?? workStatus.completedUnits.length;
	const remainingUnits = state.remainingUnitsCount ?? workStatus.remainingUnits.length;

	let workStepStatus: WorkflowStepItem["status"] = "idle";
	let workStepLabel = "[空闲]";
	let workStepDetail = "待制定带实施单元的计划文档";

	if (workStatus.isActive) {
		workStepStatus = "in_progress";
		workStepLabel = "[⚡ 运行中]";
		const percent = totalUnits > 0 ? Math.round((completedUnits / totalUnits) * 100) : 0;
		workStepDetail = `单元进度: [${renderProgressBar(completedUnits, totalUnits, 8)}] ${completedUnits}/${totalUnits} (${percent}%) 当前: ${workStatus.currentUnit || "就绪"}`;
	} else if (workStatus.lastMessage && workStatus.lastMessage.includes("暂停")) {
		workStepStatus = "in_progress";
		workStepLabel = "[⏸️ 已暂停]";
		const percent = totalUnits > 0 ? Math.round((completedUnits / totalUnits) * 100) : 0;
		workStepDetail = `单元进度: [${renderProgressBar(completedUnits, totalUnits, 8)}] ${completedUnits}/${totalUnits} (${percent}%)，已安全暂存`;
	} else if (state.activeCheckpoint?.failedUnit) {
		workStepStatus = "in_progress";
		workStepLabel = "[🛑 遇错暂停]";
		workStepDetail = `失败单元: ${state.activeCheckpoint.failedUnit}，建议排查报错`;
	} else if (totalUnits > 0) {
		if (remainingUnits === 0) {
			workStepStatus = "completed";
			workStepLabel = "[已完成]";
			workStepDetail = `全部 ${totalUnits} 个规划单元测试均已绿灯通过`;
		} else if (completedUnits > 0) {
			workStepStatus = "in_progress";
			workStepLabel = "[进行中]";
			const percent = Math.round((completedUnits / totalUnits) * 100);
			workStepDetail = `单元进度: [${renderProgressBar(completedUnits, totalUnits, 8)}] ${completedUnits}/${totalUnits} (${percent}%) 下一待办: ${state.nextUnitId || "-"}`;
		} else {
			workStepStatus = "ready";
			workStepLabel = "[就绪]";
			workStepDetail = `计划已就绪，共 ${totalUnits} 个单元待编码`;
		}
	} else if (hasPlan) {
		workStepStatus = "ready";
		workStepLabel = "[就绪]";
		workStepDetail = "计划文档已存在，随时可启动自主干活";
	}

	steps.push({
		number: "03",
		id: "03-work",
		title: "自主编码与循环推进",
		status: workStepStatus,
		statusLabel: workStepLabel,
		detail: workStepDetail,
		isCurrent: currentStepId === "03-work",
	});

	// Step 04: 04-review
	const isWorkDone = totalUnits > 0 && remainingUnits === 0;
	steps.push({
		number: "04",
		id: "04-review",
		title: "代码质量与规格审查",
		status: isWorkDone ? "ready" : state.stage === "completed" ? "completed" : "pending",
		statusLabel: state.stage === "completed" ? "[已完成]" : isWorkDone ? "[就绪]" : "[待办]",
		detail: isWorkDone
			? "单元实现已完毕，可启动全量代码审查与回归验证"
			: state.stage === "completed"
				? "审查已完成，项目规格与质量达标"
				: "建议在 Implementation Units 验证后审查",
		isCurrent: currentStepId === "04-review",
	});

	// Step 05: 05-learn
	const hasSolutions = state.solutions.length > 0;
	steps.push({
		number: "05",
		id: "05-learn",
		title: "知识复盘与经验沉淀",
		status: hasSolutions ? "completed" : state.stage === "completed" ? "ready" : "pending",
		statusLabel: hasSolutions ? "[已沉淀]" : state.stage === "completed" ? "[就绪]" : "[待办]",
		detail: hasSolutions
			? `${state.solutions.length} 个避坑指南 (最新: ${state.latestSolution?.filename || "-"})`
			: state.stage === "completed"
				? "闭环已完成，可沉淀高价值非平凡解决方案"
				: "在开发与审查完毕后进行",
		isCurrent: currentStepId === "05-learn",
	});

	return steps;
}

/**
 * Helper to calculate terminal display width considering CJK full-width characters and ANSI codes.
 */
export function getVisibleWidth(str: string): number {
	let width = 0;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code === 0x1b && str[i + 1] === "[") {
			const mIdx = str.indexOf("m", i);
			if (mIdx !== -1) {
				i = mIdx;
				continue;
			}
		}
		if (
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe10 && code <= 0xfe19) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			code >= 0x10000
		) {
			width += 2;
		} else {
			width += 1;
		}
	}
	return width;
}

/**
 * Truncates string to a maximum visible width, appending an ellipsis if truncated.
 */
export function truncateToVisibleWidth(str: string, maxWidth: number): string {
	if (getVisibleWidth(str) <= maxWidth) return str;
	let currentWidth = 0;
	let result = "";
	for (let i = 0; i < str.length; i++) {
		const char = str[i];
		const code = str.charCodeAt(i);
		const charWidth =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe10 && code <= 0xfe19) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			code >= 0x10000
				? 2
				: 1;

		if (currentWidth + charWidth + 1 > maxWidth) {
			result += "…";
			break;
		}
		result += char;
		currentWidth += charWidth;
	}
	return result;
}

export function renderBoxHeader(left: string, right = "", width = 76): string {
	const inner = width - 2;
	const l = `─ ${left} `;
	const r = right ? ` ${right} ─` : "─";
	const fixed = getVisibleWidth(l) + getVisibleWidth(r);
	const fill = Math.max(1, inner - fixed);
	return `╭${l}${"─".repeat(fill)}${r}╮`;
}

export function renderBoxLine(content: string, width = 76): string {
	const inner = width - 4;
	const truncated = truncateToVisibleWidth(content, inner);
	const visibleLen = getVisibleWidth(truncated);
	const pad = Math.max(0, inner - visibleLen);
	return `│ ${truncated}${" ".repeat(pad)} │`;
}

export function renderBoxFooter(text = "", width = 76): string {
	const inner = width - 2;
	if (!text) return `╰${"─".repeat(inner)}╯`;
	const t = `─ ${text} `;
	const fill = Math.max(1, inner - getVisibleWidth(t));
	return `╰${t}${"─".repeat(fill)}╯`;
}

/**
 * Builds a structured, visually polished compact ASCII status dashboard (Goal-style, 7 lines).
 */
export function buildWorkflowDashboard(
	state: WorkflowStateResult,
	workStatus: WorkStatus,
	boxWidth = 76,
): string {
	const steps = deriveWorkflowSteps(state, workStatus);
	const currentStep = steps.find((s) => s.isCurrent) || steps[0];

	const totalUnits = state.totalUnitsCount ?? workStatus.allUnits.length;
	const completedUnits = state.completedUnitsCount ?? workStatus.completedUnits.length;
	const percent = totalUnits > 0 ? Math.round((completedUnits / totalUnits) * 100) : 0;

	const lines: string[] = [];

	// 1. Header: 1 line
	const progressSummary =
		totalUnits > 0
			? `[${renderProgressBar(completedUnits, totalUnits, 8)}] ${completedUnits}/${totalUnits} (${percent}%)`
			: "";
	const leftTitle = `Workflow Dashboard ─ [${currentStep.id} ${currentStep.statusLabel}]`;
	lines.push(renderBoxHeader(leftTitle, progressSummary, boxWidth));

	// 2. Exactly 5 steps: 5 lines (1 clean line per step)
	for (const step of steps) {
		const marker = step.isCurrent ? "▶" : step.status === "completed" ? "✓" : "·";
		const rowContent = `  ${marker} [${step.number}] ${step.id.padEnd(14)} ${step.statusLabel.padEnd(8)} · ${step.detail}`;
		lines.push(renderBoxLine(rowContent, boxWidth));
	}

	// 3. Footer: 1 line
	lines.push(renderBoxFooter("Esc/Ctrl+C: 暂停 · 继续: 恢复 · /workflow", boxWidth));

	return lines.join("\n");
}

/**
 * Builds ultra-compact 1-line display for status bar or above-editor widget.
 */
export function buildWorkflowWidgetLines(
	state: WorkflowStateResult,
	workStatus: WorkStatus,
): string[] {
	const steps = deriveWorkflowSteps(state, workStatus);
	const currentStep = steps.find((s) => s.isCurrent) || steps[0];

	const pipeline = steps
		.map((s) => {
			const sym = s.isCurrent ? "▶" : s.status === "completed" ? "✓" : "·";
			return `${s.number}${sym}`;
		})
		.join(" ");

	const totalUnits = state.totalUnitsCount ?? workStatus.allUnits.length;
	const completedUnits = state.completedUnitsCount ?? workStatus.completedUnits.length;
	const pct = totalUnits > 0 ? Math.round((completedUnits / totalUnits) * 100) : 0;

	if (workStatus.isActive) {
		const cur = workStatus.currentUnit ? ` 当前: ${workStatus.currentUnit}` : "";
		return [
			`⚡ [${pipeline}] 03-work [${renderProgressBar(completedUnits, totalUnits, 6)}] ${completedUnits}/${totalUnits} (${pct}%)${cur} | [Esc 暂停]`,
		];
	}

	if (workStatus.lastMessage && workStatus.lastMessage.includes("暂停")) {
		return [
			`⏸️ [${pipeline}] 03-work 已暂停 [${completedUnits}/${totalUnits} 单元] | 输入“继续”恢复 | /workflow 查看看板`,
		];
	}

	return [
		`🎯 [${pipeline}] 当前: [${currentStep.number}] ${currentStep.id} ${currentStep.statusLabel} | /workflow 查看看板`,
	];
}
