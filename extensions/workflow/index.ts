import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArtifactType } from "./src/tools/artifact-helper.js";
import type { WorkLoopDriver } from "./src/driver/work-loop-driver.js";
import { isExplicit03WorkTrigger } from "./src/driver/trigger-matcher.js";

let workDriverInstance: WorkLoopDriver | null = null;
async function getWorkDriver(): Promise<WorkLoopDriver> {
	if (!workDriverInstance) {
		const { WorkLoopDriver: DriverClass } = await import("./src/driver/work-loop-driver.js");
		workDriverInstance = new DriverClass();
	}
	return workDriverInstance;
}

const workflowStateParams = {
	type: "object",
	required: ["repoRoot"],
	properties: {
		repoRoot: {
			type: "string",
			description: "Repository root path to scan for workflow artifacts",
		},
	},
} as any;

const artifactHelperParams = {
	type: "object",
	required: ["repoRoot", "artifactType"],
	properties: {
		repoRoot: {
			type: "string",
			description: "Repository root where workflow artifacts are stored",
		},
		artifactType: {
			anyOf: [
				{ type: "string", const: "brainstorm" },
				{ type: "string", const: "plan" },
				{ type: "string", const: "solution" },
				{ type: "string", const: "checkpoint" },
			],
			description: "Target artifact category",
		},
		topic: {
			type: "string",
			description: "Topic or feature name for the artifact",
		},
		date: {
			type: "string",
			description: "Date prefix formatted as YYYY-MM-DD",
		},
		ensureDir: {
			type: "boolean",
			description: "Whether to create directory if missing",
		},
	},
} as any;

const sessionCheckpointParams = {
	type: "object",
	required: ["operation", "repoRoot"],
	properties: {
		operation: {
			anyOf: [
				{ type: "string", const: "save" },
				{ type: "string", const: "load" },
				{ type: "string", const: "list" },
				{ type: "string", const: "fail" },
				{ type: "string", const: "retry" },
			],
			description: "Checkpoint action to execute",
		},
		repoRoot: {
			type: "string",
			description: "Repository root path",
		},
		planPath: {
			type: "string",
			description: "Path to the plan markdown artifact",
		},
		planSlug: {
			type: "string",
			description: "Slug identifier for the execution plan",
		},
		completedUnits: {
			type: "array",
			items: {
				type: "string",
			},
			description: "List of completed unit names",
		},
		failedUnit: {
			type: "string",
			description: "Unit name that encountered a failure",
		},
		error: {
			type: "string",
			description: "Error description or failure details",
		},
	},
} as any;

export default function workflowExtension(pi: ExtensionAPI) {
	// 1. Register workflow_state tool (Core engine for 00-next)
	pi.registerTool({
		name: "workflow_state",
		label: "Workflow State",
		description:
			"Scan repository artifacts (brainstorms, plans, checkpoints, solutions) and determine current stage and recommended next skill.",
		parameters: workflowStateParams,
		async execute(_toolCallId, params: any) {
			const { detectWorkflowState } = await import("./src/tools/workflow-state.js");
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
		async execute(_toolCallId, params: any) {
			const { resolveArtifactPath } = await import("./src/tools/artifact-helper.js");
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
		async execute(_toolCallId, params: any) {
			const { executeSessionCheckpoint } = await import("./src/tools/session-checkpoint.js");
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
		const { filterBashOutput } = await import("./src/filters/bash-output-filter.js");
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

		const { filterReadOutput } = await import("./src/filters/read-output-filter.js");
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

	// 6. User Command: /workflow (查看工作流全阶段看板与自主循环控制)
	pi.registerCommand("workflow", {
		description: "查看复合工程工作流全流程步骤状态看板与自主干活循环控制",
		async handler(args, ctx) {
			const sub = (args || "").trim().toLowerCase();
			const workDriver = await getWorkDriver();

			if (sub === "pause" || sub === "暂停") {
				if (workDriver.getStatus().isActive) {
					detachEscapeListener();
					await workDriver.pause("用户执行 /workflow pause");
					ctx.ui?.setStatus?.("workflow", undefined);
					ctx.ui?.notify?.("⏸️ 03-work 自主循环已安全暂停。", "info");
				} else {
					ctx.ui?.notify?.("⚪ 03-work 当前未处于活跃运行状态。", "info");
				}
				return;
			}

			if (sub === "resume" || sub === "继续") {
				workDriver.setRepoRoot(ctx.cwd || process.cwd());
				const res = await workDriver.start();
				if (res.success && res.status.isActive) {
					attachEscapeListener(ctx);
					ctx.ui?.setStatus?.(
						"workflow",
						`🔄 03-work 自主干活 [${res.status.completedUnits.length}/${res.status.allUnits.length}]`,
					);
					ctx.ui?.notify?.("🚀 03-work 自主循环已恢复驱动。", "info");
				} else {
					ctx.ui?.notify?.(res.message, "info");
				}
				return;
			}

			if (sub === "hide" || sub === "off" || sub === "close" || sub === "关闭" || sub === "隐藏") {
				ctx.ui?.setWidget?.("workflow", undefined);
				ctx.ui?.setStatus?.("workflow", undefined);
				ctx.ui?.notify?.("工作流状态栏已隐藏。", "info");
				return;
			}

			const { detectWorkflowState } = await import("./src/tools/workflow-state.js");
			const { buildWorkflowDashboard, buildWorkflowWidgetLines } = await import(
				"./src/tools/workflow-dashboard.js"
			);
			const repoRoot = ctx.cwd || process.cwd();
			const state = await detectWorkflowState(repoRoot);
			const workStatus = workDriver.getStatus();

			const dashboard = buildWorkflowDashboard(state, workStatus);
			if (ctx.hasUI) {
				ctx.ui.notify?.(dashboard, "info");
				const widgetLines = buildWorkflowWidgetLines(state, workStatus);
				ctx.ui.setWidget?.("workflow", widgetLines, { placement: "aboveEditor" });
			}
		},
	});

	pi.registerCommand("workflow-pause", {
		description: "暂停当前正在运行的 03-work 自主干活循环 (同 Esc / 输入 '暂停')",
		async handler(_args, ctx) {
			const workDriver = await getWorkDriver();
			if (workDriver.getStatus().isActive) {
				detachEscapeListener();
				await workDriver.pause("用户执行 /workflow-pause");
				ctx.ui?.setStatus?.("workflow", undefined);
				ctx.ui?.notify?.("⏸️ 03-work 自主循环已安全暂停。", "info");
			} else {
				ctx.ui?.notify?.("⚪ 03-work 当前未处于活跃运行状态。", "info");
			}
		},
	});

	pi.registerCommand("workflow-resume", {
		description: "恢复当前计划的 03-work 自主干活循环 (同 /skill:03-work / 输入 '继续干活')",
		async handler(_args, ctx) {
			const workDriver = await getWorkDriver();
			workDriver.setRepoRoot(ctx.cwd || process.cwd());
			const res = await workDriver.start();
			if (res.success && res.status.isActive) {
				attachEscapeListener(ctx);
				ctx.ui?.setStatus?.(
					"workflow",
					`🔄 03-work 自主干活 [${res.status.completedUnits.length}/${res.status.allUnits.length}]`,
				);
				ctx.ui?.notify?.("🚀 03-work 自主循环已恢复驱动。", "info");
			} else {
				ctx.ui?.notify?.(res.message, "info");
			}
		},
	});

	// 7. 03-work 原生自主循环驱动引擎与极轻量按需键盘中断监听
	// 仅在 03-work 自主循环运行时按需挂载 Esc 监听，暂停或结束时立即脱钩，日常打字 0 开销
	let terminalInputUnsub: (() => void) | null = null;
	async function attachEscapeListener(ctx: ExtensionContext) {
		if (ctx.hasUI && !terminalInputUnsub && ctx.ui?.onTerminalInput) {
			const { matchesKey } = await import("@earendil-works/pi-tui");
			terminalInputUnsub = ctx.ui.onTerminalInput((data: string) => {
				if (
					(data === "\x1b" || matchesKey(data, "escape")) &&
					workDriverInstance &&
					workDriverInstance.getStatus().isActive
				) {
					detachEscapeListener();
					workDriverInstance.pause("用户按 Esc 中断");
					ctx.ui?.setStatus?.("workflow", undefined);
					ctx.ui?.notify?.(
						"⏸️ 03-work 自主循环已响应 Esc 安全暂停。随时输入“继续”或调用 /skill:03-work 即可恢复。",
						"info",
					);
					// 不消费按键，透传给宿主让 Pi 终止当前正在运行的模型回合或工具命令
					return undefined;
				}
				return undefined;
			});
		}
	}

	function detachEscapeListener() {
		if (terminalInputUnsub) {
			terminalInputUnsub();
			terminalInputUnsub = null;
		}
	}

	// 监听用户输入与技能启动：只有显式触发 03-work 时才启动自主循环（绝不读取 systemPrompt）
	pi.on("before_agent_start", async (event, ctx) => {
		const is03Work = isExplicit03WorkTrigger(event.prompt);

		if (is03Work && (!workDriverInstance || !workDriverInstance.getStatus().isActive)) {
			const workDriver = await getWorkDriver();
			workDriver.setRepoRoot(ctx.cwd || process.cwd());
			const res = await workDriver.start();
			if (res.success && res.status.isActive) {
				attachEscapeListener(ctx);
				const nextUnit = res.status.currentUnit ? `下一个: ${res.status.currentUnit}` : "准备就绪";
				ctx.ui?.setStatus?.(
					"workflow",
					`🔄 03-work 自主干活 [${res.status.completedUnits.length}/${res.status.allUnits.length}] ${nextUnit}`,
				);
			}
		}
	});

	// 监听用户打断指令：用户若输入“暂停”或“停止”，自动安全挂起 03 自主循环
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };

		const text = event.text.trim().toLowerCase();
		if (
			workDriverInstance &&
			workDriverInstance.getStatus().isActive &&
			(text === "暂停" || text === "停止" || text === "pause" || text === "stop")
		) {
			detachEscapeListener();
			await workDriverInstance.pause("用户手动输入暂停");
			ctx.ui?.setStatus?.("workflow", undefined);
			ctx.ui?.notify?.(
				"⏸️ 03-work 自主循环已暂停。随时输入“继续”或调用 /skill:03-work 即可恢复。",
				"info",
			);
			return { action: "handled" };
		}

		return { action: "continue" };
	});

	// 监听单轮结束 (turn_end)：若因 Ctrl+C / Esc 导致当前轮次被中止，立即安全挂起
	pi.on("turn_end", async (event, ctx) => {
		const msg = event.message as any;
		if (
			workDriverInstance &&
			workDriverInstance.getStatus().isActive &&
			msg?.role === "assistant" &&
			msg?.stopReason === "aborted"
		) {
			detachEscapeListener();
			await workDriverInstance.pause("检测到助理回合中断 (stopReason: aborted)");
			ctx.ui?.setStatus?.("workflow", undefined);
		}
	});

	// 监听整段运行结束 (agent_end)：在 agent_end 中无缝驱动下一单元 (Native Continuous Loop)
	pi.on("agent_end", async (event, ctx) => {
		if (workDriverInstance && workDriverInstance.getStatus().isActive) {
			await workDriverInstance.onAgentEnd(event, ctx, pi);
			if (!workDriverInstance.getStatus().isActive) {
				detachEscapeListener();
			}
		}
	});

	// 核心事件循环兜底：每个回合彻底结算后，若仍有未完成单元，提供二次兜底保障
	pi.on("agent_settled", async (_event, ctx) => {
		if (workDriverInstance && workDriverInstance.getStatus().isActive) {
			await workDriverInstance.onAgentSettled(ctx, pi);
			if (!workDriverInstance.getStatus().isActive) {
				detachEscapeListener();
			}
		}
	});

	pi.on("session_shutdown", async () => {
		detachEscapeListener();
		workDriverInstance?.cancelTimer();
	});
}
