import path from "node:path";
import { readdir, stat, readFile } from "node:fs/promises";
import type { CheckpointData } from "./session-checkpoint.js";

export interface ArtifactSummary {
	filename: string;
	relativePath: string;
	mtimeMs: number;
}

export interface WorkflowStateResult {
	repoRoot: string;
	hasArtifacts: boolean;
	stage: "idle" | "brainstormed" | "planned" | "working" | "reviewing" | "completed";
	recommendedSkill: "01-brainstorm" | "02-plan" | "03-work" | "04-review" | "05-learn";
	recommendationReason: string;
	brainstorms: ArtifactSummary[];
	plans: ArtifactSummary[];
	solutions: ArtifactSummary[];
	checkpoints: CheckpointData[];
	latestBrainstorm?: ArtifactSummary;
	latestPlan?: ArtifactSummary;
	latestSolution?: ArtifactSummary;
	activeCheckpoint?: CheckpointData;
}

async function safeListMarkdownFiles(dir: string, relBase: string): Promise<ArtifactSummary[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		const results: ArtifactSummary[] = [];
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith(".")) {
				const fullPath = path.join(dir, entry.name);
				const s = await stat(fullPath);
				results.push({
					filename: entry.name,
					relativePath: path.join(relBase, entry.name).replace(/\\/g, "/"),
					mtimeMs: s.mtimeMs,
				});
			}
		}
		results.sort((a, b) => b.mtimeMs - a.mtimeMs);
		return results;
	} catch {
		return [];
	}
}

async function safeListCheckpoints(dir: string): Promise<CheckpointData[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		const results: CheckpointData[] = [];
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".json")) {
				try {
					const content = await readFile(path.join(dir, entry.name), "utf-8");
					results.push(JSON.parse(content));
				} catch {}
			}
		}
		results.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
		return results;
	} catch {
		return [];
	}
}

export async function detectWorkflowState(repoRoot: string): Promise<WorkflowStateResult> {
	const brainstormsDir = path.resolve(repoRoot, "docs", "brainstorms");
	const plansDir = path.resolve(repoRoot, "docs", "plans");
	const solutionsDir = path.resolve(repoRoot, "docs", "solutions");
	const checkpointsDir = path.resolve(repoRoot, ".context", "checkpoints");

	const [brainstorms, plans, solutions, checkpoints] = await Promise.all([
		safeListMarkdownFiles(brainstormsDir, "docs/brainstorms"),
		safeListMarkdownFiles(plansDir, "docs/plans"),
		safeListMarkdownFiles(solutionsDir, "docs/solutions"),
		safeListCheckpoints(checkpointsDir),
	]);

	const latestBrainstorm = brainstorms[0];
	const latestPlan = plans[0];
	const latestSolution = solutions[0];
	const activeCheckpoint = checkpoints[0];

	const hasArtifacts =
		brainstorms.length > 0 || plans.length > 0 || solutions.length > 0 || checkpoints.length > 0;

	// Decision engine for recommended next stage:
	let stage: WorkflowStateResult["stage"] = "idle";
	let recommendedSkill: WorkflowStateResult["recommendedSkill"] = "01-brainstorm";
	let recommendationReason = "当前尚未创建需求产物，建议运行 01-brainstorm 进行需求发现与范围确认。";

	if (!hasArtifacts || brainstorms.length === 0) {
		stage = "idle";
		recommendedSkill = "01-brainstorm";
		recommendationReason =
			"当前项目尚未创建需求文档，建议运行 01-brainstorm 梳理业务目标、技术边界与交互细节。";
	} else if (plans.length === 0) {
		stage = "brainstormed";
		recommendedSkill = "02-plan";
		recommendationReason = `发现最新需求文档「${latestBrainstorm.filename}」，尚未生成执行计划。建议运行 02-plan 拆解技术架构与 TDD Implementation Units。`;
	} else if (activeCheckpoint && activeCheckpoint.failedUnit) {
		stage = "working";
		recommendedSkill = "03-work";
		recommendationReason = `执行计划断点中记录了失败单元「${activeCheckpoint.failedUnit}」，建议运行 03-work 诊断根因并继续执行。`;
	} else if (
		activeCheckpoint &&
		activeCheckpoint.completedUnits &&
		activeCheckpoint.completedUnits.length > 0 &&
		latestPlan &&
		latestPlan.mtimeMs > (activeCheckpoint ? new Date(activeCheckpoint.updatedAt).getTime() : 0)
	) {
		// Plan was modified after checkpoint
		stage = "planned";
		recommendedSkill = "03-work";
		recommendationReason = `计划文档「${latestPlan.filename}」有更新，建议运行 03-work 继续落实未完成的实现单元。`;
	} else if (!activeCheckpoint && latestPlan) {
		stage = "planned";
		recommendedSkill = "03-work";
		recommendationReason = `已生成计划文档「${latestPlan.filename}」，建议运行 03-work 启动 TDD 编码执行。`;
	} else if (
		activeCheckpoint &&
		activeCheckpoint.completedUnits &&
		activeCheckpoint.completedUnits.length > 0
	) {
		stage = "working";
		recommendedSkill = "04-review";
		recommendationReason = `计划单元已完成执行（已完成 ${activeCheckpoint.completedUnits.length} 个单元）。建议运行 04-review 进行代码审查、规范校验与功能自测。`;
	} else {
		stage = "completed";
		recommendedSkill = "05-learn";
		recommendationReason =
			"开发流程已基本完成。建议运行 05-learn 进行极简复盘，将具有长期价值的避坑经验沉淀到 docs/solutions/。";
	}

	return {
		repoRoot,
		hasArtifacts,
		stage,
		recommendedSkill,
		recommendationReason,
		brainstorms,
		plans,
		solutions,
		checkpoints,
		latestBrainstorm,
		latestPlan,
		latestSolution,
		activeCheckpoint,
	};
}
