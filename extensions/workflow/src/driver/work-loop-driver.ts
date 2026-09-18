import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeSessionCheckpoint, type CheckpointData } from "../tools/session-checkpoint.js";
import { slugify } from "../tools/artifact-helper.js";

export interface PlanUnit {
	id: string; // e.g. "Unit 0"
	title: string; // e.g. "Unit 0 — 探针：面板焦点 / 键盘 / IME"
	raw: string;
}

export interface WorkStatus {
	isActive: boolean;
	planPath: string | null;
	planSlug: string | null;
	allUnits: string[];
	completedUnits: string[];
	remainingUnits: string[];
	currentUnit: string | null;
	failedUnit: string | null;
	consecutiveFailures: number;
	lastFailureError?: string;
	failureHistory?: Array<{ unit: string; error?: string; timestamp: string }>;
	currentRunCount: number;
	maxRuns: number;
	lastMessage?: string;
}

export interface WorkStartResult {
	success: boolean;
	message: string;
	status: WorkStatus;
}

/**
 * Parses Implementation Units from plan markdown.
 * Supports:
 * - `### Unit 0 — ...` or `### Unit 0: ...` or `## Unit 0`
 * - `### Implementation Unit 0: ...`
 * - `- [ ] Unit 0: ...`
 */
export function parsePlanUnits(markdown: string): PlanUnit[] {
	const units: PlanUnit[] = [];
	const seen = new Set<string>();

	const lines = markdown.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();

		// Header match: ### Unit 0 — ... or ### Implementation Unit 1: ...
		const headerMatch = trimmed.match(
			/^#{2,4}\s+(?:Implementation\s+Unit|Unit)\s+([0-9A-Za-z_-]+)(?:\s*[:—–-]\s*(.*))?$/i,
		);
		if (headerMatch) {
			const id = `Unit ${headerMatch[1]}`;
			if (!seen.has(id.toLowerCase())) {
				seen.add(id.toLowerCase());
				const title = headerMatch[2] ? `${id} — ${headerMatch[2].trim()}` : id;
				units.push({ id, title, raw: trimmed });
				continue;
			}
		}

		// List match: - [ ] Unit 0: ... or - [x] Unit 0
		const listMatch = trimmed.match(
			/^-\s+\[[ xX]\]\s+(?:Implementation\s+Unit|Unit)\s+([0-9A-Za-z_-]+)(?:\s*[:—–-]\s*(.*))?$/i,
		);
		if (listMatch) {
			const id = `Unit ${listMatch[1]}`;
			if (!seen.has(id.toLowerCase())) {
				seen.add(id.toLowerCase());
				const title = listMatch[2] ? `${id} — ${listMatch[2].trim()}` : id;
				units.push({ id, title, raw: trimmed });
			}
		}
	}

	return units;
}

/**
 * Finds the latest plan markdown file in `docs/plans/`.
 */
export async function findLatestPlanFile(repoRoot: string): Promise<string | null> {
	const plansDir = path.resolve(repoRoot, "docs", "plans");
	try {
		const files = await readdir(plansDir);
		const mdFiles = files.filter((f) => f.endsWith(".md") && !f.startsWith("."));
		if (mdFiles.length === 0) return null;
		mdFiles.sort().reverse();
		return path.join(plansDir, mdFiles[0]);
	} catch {
		return null;
	}
}

export { isExplicit03WorkTrigger } from "./trigger-matcher.js";

/**
 * Autonomous Loop Driver for 03-work.
 * Ensures the agent drives continuously across turns until all planned units are 100% finished.
 */
export class WorkLoopDriver {
	private repoRoot: string;
	private isActive = false;
	private planPath: string | null = null;
	private planSlug: string | null = null;
	private allUnits: PlanUnit[] = [];
	private completedUnits = new Set<string>();
	private failedUnit: string | null = null;
	private consecutiveFailures = 0;
	private lastFailureError: string | null = null;
	private failureHistory: Array<{ unit: string; error?: string; timestamp: string }> = [];
	private currentRunCount = 0;
	private maxRuns = 50; // Safety threshold against infinite runaway loops
	private timer: NodeJS.Timeout | null = null;
	private lastMessage = "";

	constructor(repoRoot?: string) {
		this.repoRoot = repoRoot || process.cwd();
	}

	setRepoRoot(repoRoot: string) {
		this.repoRoot = repoRoot;
	}

	getStatus(): WorkStatus {
		const allIds = this.allUnits.map((u) => u.id);
		const completedList = Array.from(this.completedUnits);
		const remaining = allIds.filter((id) => !this.completedUnits.has(id));
		const current = remaining.length > 0 ? remaining[0] : null;

		return {
			isActive: this.isActive,
			planPath: this.planPath,
			planSlug: this.planSlug,
			allUnits: allIds,
			completedUnits: completedList,
			remainingUnits: remaining,
			currentUnit: current,
			failedUnit: this.failedUnit,
			consecutiveFailures: this.consecutiveFailures,
			lastFailureError: this.lastFailureError || undefined,
			failureHistory: [...this.failureHistory],
			currentRunCount: this.currentRunCount,
			maxRuns: this.maxRuns,
			lastMessage: this.lastMessage,
		};
	}

	/**
	 * Starts autonomous work loop on a target plan.
	 */
	async start(explicitPlanPath?: string): Promise<WorkStartResult> {
		this.cancelTimer();
		let targetPlan = explicitPlanPath;
		if (!targetPlan) {
			const latest = await findLatestPlanFile(this.repoRoot);
			if (!latest) {
				return {
					success: false,
					message: "未在 docs/plans/ 目录下发现任何执行计划文档，请先运行 /skill:02-plan 制定计划。",
					status: this.getStatus(),
				};
			}
			targetPlan = latest;
		}

		targetPlan = path.resolve(this.repoRoot, targetPlan);
		let content = "";
		try {
			content = await readFile(targetPlan, "utf-8");
		} catch (err) {
			return {
				success: false,
				message: `无法读取计划文件: ${targetPlan} (${err instanceof Error ? err.message : String(err)})`,
				status: this.getStatus(),
			};
		}

		const units = parsePlanUnits(content);
		if (units.length === 0) {
			return {
				success: false,
				message: `在计划文件中未检测到任何 Implementation Units (如 ### Unit 0)。请检查计划格式。`,
				status: this.getStatus(),
			};
		}

		this.planPath = targetPlan;
		this.planSlug = slugify(path.basename(targetPlan, path.extname(targetPlan)));
		this.allUnits = units;
		this.currentRunCount = 0;
		this.consecutiveFailures = 0;
		this.failedUnit = null;
		this.lastFailureError = null;
		this.failureHistory = [];

		// Load existing checkpoint
		const cpResult = await executeSessionCheckpoint({
			operation: "load",
			repoRoot: this.repoRoot,
			planPath: targetPlan,
			planSlug: this.planSlug,
		});

		this.completedUnits.clear();
		if (cpResult.checkpoint && cpResult.checkpoint.completedUnits) {
			for (const u of cpResult.checkpoint.completedUnits) {
				this.completedUnits.add(u);
			}
		}

		const status = this.getStatus();
		if (status.remainingUnits.length === 0) {
			this.isActive = false;
			this.lastMessage = `🎉 所有规划单元 (${units.length}/${units.length}) 均已完成！`;
			return {
				success: true,
				message: `${this.lastMessage} 推荐直接执行 /skill:04-review 进行全量代码审查。`,
				status: this.getStatus(),
			};
		}

		this.isActive = true;
		this.lastMessage = `🚀 03-work 自主循环驱动已激活：共 ${units.length} 个单元，已完成 ${this.completedUnits.size} 个，待执行 ${status.remainingUnits.length} 个。`;
		return {
			success: true,
			message: this.lastMessage,
			status: this.getStatus(),
		};
	}

	/**
	 * Pauses or stops the autonomous work loop.
	 */
	async pause(reason = "用户主动暂停"): Promise<WorkStatus> {
		this.cancelTimer();
		this.isActive = false;
		this.lastMessage = `⏸️ 03-work 自主循环已暂停 (${reason})`;
		return this.getStatus();
	}

	cancelTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Generates autonomous execution prompt for the next unit.
	 */
	generatePromptForNextUnit(): string | null {
		const status = this.getStatus();
		if (!status.currentUnit || !this.planPath) return null;

		const unitObj = this.allUnits.find((u) => u.id === status.currentUnit);
		const unitTitle = unitObj ? unitObj.title : status.currentUnit;
		const completedList = Array.from(this.completedUnits).join(", ") || "无";
		const percent = Math.round((status.completedUnits.length / status.allUnits.length) * 100);

		return [
			`【03-work 自主循环驱动引擎 · 自动化续跑指令】`,
			`⚡ 状态: 自主工作模式（不做完不停机）`,
			`📄 计划文件: ${this.planPath}`,
			`📊 进度看板: ${status.completedUnits.length}/${status.allUnits.length} 单元 (${percent}%)`,
			`✅ 已完成: [ ${completedList} ]`,
			`🎯 当前必须完成的目标: 【${unitTitle}】`,
			``,
			`请严格执行以下闭环操作，完成后自动推进，严禁询问确认：`,
			`1. 遵循 TDD (红-绿-重构)：编写/补充针对 ${status.currentUnit} 的测试用例。`,
			`2. 编写最小化实现代码，执行该单元的确定性验证命令，确保全绿灯。`,
			`3. 验证通过后，【必须立即调用】session_checkpoint({ operation: "save", planPath: "${this.planPath}", completedUnits: ["${status.currentUnit}"] }) 保存断点。`,
			`4. 若遇到非预期报错，排查根因。若重试仍失败，调用 session_checkpoint({ operation: "fail", planPath: "${this.planPath}", failedUnit: "${status.currentUnit}", error: "..." })。`,
			`5. 执行完毕后若无致命异常，请直接准备推进下一单元。`,
		].join("\n");
	}

	/**
	 * Hooks into agent_settled to evaluate completion and trigger next turn if needed.
	 */
	async onAgentSettled(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
		if (!this.isActive || !this.planPath) return;

		// 1. Check if user aborted (Esc pressed, abort signal, or aborted assistant message)
		if (ctx.signal?.aborted) {
			await this.pause("检测到用户中断信号 (Esc/Abort)");
			ctx.ui?.setStatus?.("workflow", undefined);
			ctx.ui?.notify?.("⏸️ 03-work 自主循环已响应中断信号安全暂停。", "info");
			return;
		}

		try {
			const branch = ctx.sessionManager?.getBranch?.() ?? [];
			const lastMsgEntry = branch
				.slice()
				.reverse()
				.find((e: any) => e?.type === "message" && e?.message?.role === "assistant");
			const lastAssistantMsg = (lastMsgEntry as any)?.message;
			if (lastAssistantMsg?.stopReason === "aborted") {
				await this.pause("检测到会话中断 (stopReason: aborted)");
				ctx.ui?.setStatus?.("workflow", undefined);
				ctx.ui?.notify?.("⏸️ 03-work 自主循环已响应中断信号安全暂停。", "info");
				return;
			}
		} catch {}

		// 2. Re-read checkpoint from disk to see what the agent achieved in this turn
		const cpResult = await executeSessionCheckpoint({
			operation: "load",
			repoRoot: this.repoRoot,
			planPath: this.planPath,
			planSlug: this.planSlug || undefined,
		});

		if (cpResult.checkpoint) {
			const cp = cpResult.checkpoint;
			if (cp.completedUnits) {
				for (const u of cp.completedUnits) {
					this.completedUnits.add(u);
				}
			}

			// Check Stop-The-Line failure gate
			if (cp.failedUnit) {
				this.failedUnit = cp.failedUnit;
				this.consecutiveFailures += 1;
				this.lastFailureError = cp.error || "未知测试失败";
				this.failureHistory.push({
					unit: cp.failedUnit,
					error: cp.error,
					timestamp: new Date().toISOString(),
				});
				if (this.consecutiveFailures >= 3) {
					await this.pause(
						`硬门禁触发：${cp.failedUnit} 连续排查修复未果 (${this.lastFailureError})，触发 Stop-The-Line 遇错即停保护。`,
					);
					ctx.ui?.notify?.(
						`🛑 03-work 遇到连续失败，已启动遇错即停硬门禁保护，请排查原因。`,
						"error",
					);
					return;
				}
			} else {
				this.consecutiveFailures = 0;
				this.failedUnit = null;
				this.lastFailureError = null;
			}
		}

		// 3. Check if all units are finished
		const status = this.getStatus();
		if (status.remainingUnits.length === 0) {
			this.isActive = false;
			ctx.ui?.setStatus?.("workflow", undefined);
			ctx.ui?.notify?.(
				`🎉 03-work 全部 ${this.allUnits.length} 个规划单元已全部实现并验证通过！自动流转至 04-review 审查阶段。`,
				"info",
			);

			// Automatically transition to 04-review
			try {
				pi.sendUserMessage(
					"【03-work 全部单元已圆满完成】所有 Implementation Units 测试与验收命令均已绿灯通过。现在自动启动 /skill:04-review 进行最终质量审查与回归核验。",
					{ deliverAs: "followUp", expandPromptTemplates: true },
				);
			} catch (err) {
				console.error("[03-work driver] failed to send 04-review transition message:", err);
			}
			return;
		}

		// 4. Safety runaway cap
		this.currentRunCount += 1;
		if (this.currentRunCount > this.maxRuns) {
			await this.pause(`自主续跑轮次已达安全上限 (${this.maxRuns} 轮)，避免无限死循环。`);
			ctx.ui?.notify?.(
				`⚠️ 03-work 连续执行已达安全上限 (${this.maxRuns} 次)，已暂停。可通过 /skill:03-work 重新恢复。`,
				"warning",
			);
			return;
		}

		// 5. Update footer status
		const percent = Math.round((status.completedUnits.length / status.allUnits.length) * 100);
		ctx.ui?.setStatus?.(
			"workflow",
			`🔄 03-work 自主干活 [${status.completedUnits.length}/${status.allUnits.length} - ${percent}%] 下一个: ${status.currentUnit}`,
		);

		// 6. Schedule next autonomous turn
		const nextPrompt = this.generatePromptForNextUnit();
		if (!nextPrompt) return;

		this.cancelTimer();
		// Give a brief 100ms pause so Pi's event loop settles cleanly, then dispatch follow-up
		this.timer = setTimeout(() => {
			try {
				this.timer = null;
				if (!this.isActive) return;

				pi.sendUserMessage(nextPrompt, {
					deliverAs: "followUp",
					expandPromptTemplates: true,
				});
			} catch (err) {
				console.error("[03-work driver] setTimeout callback failed:", err);
				this.isActive = false;
				this.cancelTimer();
				ctx.ui?.setStatus?.("workflow", undefined);
				ctx.ui?.notify?.("⚠️ 03-work 自主循环遇到内部错误已暂停，请查看日志。", "warning");
				this.lastMessage = `续跑调度异常: ${err instanceof Error ? err.message : String(err)}`;
			}
		}, 100);
		this.timer.unref?.();
	}
}
