import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveArtifactPath, type ArtifactType } from "./src/tools/artifact-helper.js";
import { detectWorkflowState } from "./src/tools/workflow-state.js";
import { executeSessionCheckpoint } from "./src/tools/session-checkpoint.js";
import { filterBashOutput } from "./src/filters/bash-output-filter.js";
import { filterReadOutput } from "./src/filters/read-output-filter.js";

const workflowStateParams = Type.Object({
	repoRoot: Type.String({ description: "Repository root path to scan for workflow artifacts" }),
});

const artifactHelperParams = Type.Object({
	repoRoot: Type.String({ description: "Repository root where workflow artifacts are stored" }),
	artifactType: Type.Union(
		[
			Type.Literal("brainstorm"),
			Type.Literal("plan"),
			Type.Literal("solution"),
			Type.Literal("checkpoint"),
		],
		{ description: "Target artifact category" },
	),
	topic: Type.Optional(Type.String({ description: "Topic or feature name for the artifact" })),
	date: Type.Optional(Type.String({ description: "Date prefix formatted as YYYY-MM-DD" })),
	ensureDir: Type.Optional(Type.Boolean({ description: "Whether to create directory if missing" })),
});

const sessionCheckpointParams = Type.Object({
	operation: Type.Union(
		[
			Type.Literal("save"),
			Type.Literal("load"),
			Type.Literal("list"),
			Type.Literal("fail"),
			Type.Literal("retry"),
		],
		{ description: "Checkpoint action to execute" },
	),
	repoRoot: Type.String({ description: "Repository root path" }),
	planPath: Type.Optional(Type.String({ description: "Path to the plan markdown artifact" })),
	planSlug: Type.Optional(Type.String({ description: "Slug identifier for the execution plan" })),
	completedUnits: Type.Optional(
		Type.Array(Type.String(), { description: "List of completed unit names" }),
	),
	failedUnit: Type.Optional(Type.String({ description: "Unit name that encountered a failure" })),
	error: Type.Optional(Type.String({ description: "Error description or failure details" })),
});

export default function workflowExtension(pi: ExtensionAPI) {
	// 1. Register workflow_state tool (Core engine for 00-next)
	pi.registerTool({
		name: "workflow_state",
		label: "Workflow State",
		description:
			"Scan repository artifacts (brainstorms, plans, checkpoints, solutions) and determine current stage and recommended next skill.",
		parameters: workflowStateParams,
		async execute(_toolCallId, params) {
			const result = await detectWorkflowState(params.repoRoot);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	// 2. Register artifact_helper tool
	pi.registerTool({
		name: "artifact_helper",
		label: "Artifact Helper",
		description:
			"Resolve and optionally create standard Compound Engineering artifact paths under docs/ or .context/.",
		parameters: artifactHelperParams,
		async execute(_toolCallId, params) {
			const result = await resolveArtifactPath({
				repoRoot: params.repoRoot,
				artifactType: params.artifactType as ArtifactType,
				topic: params.topic,
				date: params.date,
				ensureDir: params.ensureDir,
			});
			return {
				content: [{ type: "text", text: result.path }],
				details: result,
			};
		},
	});

	// 3. Register session_checkpoint tool
	pi.registerTool({
		name: "session_checkpoint",
		label: "Session Checkpoint",
		description:
			"Manage plan execution checkpoints: save completed units, load breakpoints, record errors, and retry failed units.",
		parameters: sessionCheckpointParams,
		async execute(_toolCallId, params) {
			const result = await executeSessionCheckpoint({
				operation: params.operation,
				repoRoot: params.repoRoot,
				planPath: params.planPath,
				planSlug: params.planSlug,
				completedUnits: params.completedUnits,
				failedUnit: params.failedUnit,
				error: params.error,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	// 4. Hook: Bash output smart filter (Reduce context waste from verbose commands)
	pi.on("tool_result", async (event, _ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = (event.input as { command?: string })?.command ?? "";
		if (!command) return undefined;

		const textBlocks =
			(event.content as Array<{ type: string; text?: string }>)?.filter(
				(b) => b.type === "text",
			) ?? [];
		if (textBlocks.length === 0) return undefined;

		const output = textBlocks.map((b) => b.text ?? "").join("");
		const result = filterBashOutput({
			command,
			output,
			isError: event.isError ?? false,
		});

		if (!result.filtered) return undefined;

		return {
			content: [{ type: "text", text: result.output }],
			details: {
				...(event.details && typeof event.details === "object" ? event.details : {}),
				bashFilter: {
					strategy: result.strategy,
					originalBytes: result.originalBytes,
					filteredBytes: result.filteredBytes,
				},
			},
		};
	});

	// 5. Hook: Read output filter (Reduce context waste from large lockfiles and long texts)
	pi.on("tool_result", async (event, _ctx) => {
		if (event.toolName !== "read") return undefined;

		const filePath = (event.input as { path?: string })?.path ?? "";
		if (!filePath) return undefined;

		const textBlocks =
			(event.content as Array<{ type: string; text?: string }>)?.filter(
				(b) => b.type === "text",
			) ?? [];
		if (textBlocks.length === 0) return undefined;

		const output = textBlocks.map((b) => b.text ?? "").join("");
		const isImage =
			(event.content as Array<{ type: string }>)?.some((b) => b.type === "image") ?? false;

		const result = filterReadOutput({
			path: filePath,
			output,
			isError: event.isError ?? false,
			isImage,
		});

		if (!result.filtered) return undefined;

		return {
			content: [{ type: "text", text: result.output }],
			details: {
				...(event.details && typeof event.details === "object" ? event.details : {}),
				readFilter: {
					strategy: result.strategy,
					originalBytes: result.originalBytes,
					filteredBytes: result.filteredBytes,
				},
			},
		};
	});

	// 6. User Command: /workflow
	pi.registerCommand("workflow", {
		description: "查看当前项目的复合工程流状态与下一步推荐技能",
		async handler(_args, ctx) {
			const repoRoot = ctx.cwd || process.cwd();
			const state = await detectWorkflowState(repoRoot);

			const msg = [
				`🎯 **复合工程工作流状态 (Compound Engineering)**`,
				`📁 仓库路径: \`${state.repoRoot}\``,
				`📊 当前阶段: **${state.stage.toUpperCase()}**`,
				`🚀 推荐下一步: \`/skill:${state.recommendedSkill}\``,
				`💡 理由: ${state.recommendationReason}`,
				``,
				`📋 **产物概览**:`,
				`- 需求文档 (Brainstorms): ${state.brainstorms.length} 个 ${state.latestBrainstorm ? `(最新: ${state.latestBrainstorm.filename})` : ""}`,
				`- 执行计划 (Plans): ${state.plans.length} 个 ${state.latestPlan ? `(最新: ${state.latestPlan.filename})` : ""}`,
				`- 运行断点 (Checkpoints): ${state.checkpoints.length} 个 ${state.activeCheckpoint ? `(已完成: ${state.activeCheckpoint.completedUnits.length} 单元)` : ""}`,
				`- 避坑经验 (Solutions): ${state.solutions.length} 个 ${state.latestSolution ? `(最新: ${state.latestSolution.filename})` : ""}`,
			].join("\n");

			if (ctx.hasUI) {
				ctx.ui.notify?.(msg, "info");
			}
		},
	});
}
