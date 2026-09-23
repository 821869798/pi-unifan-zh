import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeSessionCheckpoint, type CheckpointData } from "../tools/session-checkpoint.js";
import { slugify } from "../tools/artifact-helper.js";

export interface PlanUnit {
	id: string; // e.g. "Unit 0"
	title: string; // e.g. "Unit 0 — 探针：面板焦点 / 键盘 / IME"
	raw: string;
	checked?: boolean;
}

/**
 * 规范化单元标识符（如将 "Unit 0: DB Schema"、"unit 0"、"0" 等统一映射至标准 Unit ID）
 */
export function normalizeUnitId(rawId: string, knownUnits?: PlanUnit[]): string {
	if (!rawId) return "";
	const trimmed = rawId
		.trim()
		.replace(/^#+\s*/, "")
		.replace(/^[-*+]\s*(?:\[[ xX]\]\s*)?/, "")
		.replace(/^\d+\.\s*(?:\[[ xX]\]\s*)?/, "");

	if (knownUnits && knownUnits.length > 0) {
		const exact = knownUnits.find((u) => u.id.toLowerCase() === trimmed.toLowerCase());
		if (exact) return exact.id;

		const starts = knownUnits.find((u) => trimmed.toLowerCase().startsWith(u.id.toLowerCase()));
		if (starts) return starts.id;

		const numMatch = trimmed.match(/(\d+)/);
		if (numMatch) {
			const found = knownUnits.find((u) => {
				const uNum = u.id.match(/(\d+)/);
				return uNum && uNum[1] === numMatch[1];
			});
			if (found) return found.id;
		}
	}

	const unitMatch = trimmed.match(/^(?:Implementation\s+Unit|Unit)\s*([0-9A-Za-z_-]+)/i);
	if (unitMatch) return `Unit ${unitMatch[1]}`;

	const zhMatch = trimmed.match(/^(?:步骤|单元|任务|阶段)\s*([0-9A-Za-z_-]+|[一二三四五六七八九十]+)/i);
	if (zhMatch) return `步骤 ${zhMatch[1]}`;

	const enMatch = trimmed.match(/^(?:Step|Task|Phase)\s*([0-9A-Za-z_-]+)/i);
	if (enMatch) return `Unit ${enMatch[1]}`;

	const numOnly = trimmed.match(/^([0-9]+)$/);
	if (numOnly) return `Unit ${numOnly[1]}`;

	return trimmed;
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
 * 从计划 Markdown 中解析执行单元 (Implementation Units / 步骤 / 任务)
 * 支持格式：
 * - `### Unit 0 — ...` / `### Unit 0: ...` / `## Unit 0`
 * - `### Implementation Unit 0: ...`
 * - `### 步骤 1: ...` / `### 步骤一: ...` / `### 单元 1: ...` / `### 任务 1: ...`
 * - `### Step 1: ...` / `### Task 1: ...`
 * - `- [ ] Unit 0: ...` / `- [x] Unit 0: ...`
 * - `- [ ] 步骤 1: ...` / `- [x] 步骤 1: ...`
 * - `- [ ] 1. xxx` / `- [x] 1. xxx`
 */
export function parsePlanUnits(markdown: string): PlanUnit[] {
	const units: PlanUnit[] = [];
	const seen = new Set<string>();

	const lines = markdown.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();

		// 1. 标题匹配: ### Unit 0 — ... 或 ### 步骤 1: ... 或 ### 任务 1: ...
		const headerMatch = trimmed.match(
			/^#{2,4}\s+(?:Implementation\s+Unit|Unit|步骤|单元|任务|阶段|Step|Task|Phase)\s*([0-9A-Za-z_-]+|[一二三四五六七八九十]+)(?:\s*[:—–-]\s*(.*))?$/i,
		);
		if (headerMatch) {
			const rawKey = headerMatch[1];
			const isZh = /^(?:步骤|单元|任务|阶段)/.test(trimmed.replace(/^#{2,4}\s+/, ""));
			const id = isZh ? `步骤 ${rawKey}` : `Unit ${rawKey}`;
			const lowerId = id.toLowerCase();
			if (!seen.has(lowerId)) {
				seen.add(lowerId);
				const title = headerMatch[2] ? `${id} — ${headerMatch[2].trim()}` : id;
				const checked = /\[[xX]\]|~~/.test(trimmed);
				units.push({ id, title, raw: trimmed, checked });
				continue;
			}
		}

		// 2. 复选框/列表匹配: - [ ] Unit 0: ... 或 - [x] 步骤 1: ... 或 - [x] 1. ...
		const listMatch = trimmed.match(
			/^(?:-\s+|\d+\.\s+)\[([ xX])\]\s+(?:(?:Implementation\s+Unit|Unit|步骤|单元|任务|阶段|Step|Task|Phase)\s*)?([0-9A-Za-z_-]+|[一二三四五六七八九十]+)(?:[:.、—–-]\s*(.*))?$/i,
		);
		if (listMatch) {
			const isChecked = listMatch[1].toLowerCase() === "x";
			const rawKey = listMatch[2];
			const isZh = /(?:步骤|单元|任务|阶段)/.test(trimmed);
			const id = isZh ? `步骤 ${rawKey}` : `Unit ${rawKey}`;
			const lowerId = id.toLowerCase();
			if (!seen.has(lowerId)) {
				seen.add(lowerId);
				const title = listMatch[3] ? `${id} — ${listMatch[3].trim()}` : id;
				units.push({ id, title, raw: trimmed, checked: isChecked });
			} else if (isChecked) {
				const existing = units.find((u) => u.id.toLowerCase() === lowerId);
				if (existing) existing.checked = true;
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
	private continuationDispatched = false;

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
	 * 同步最新进度：同时读取 Markdown 计划文档中的已勾选复选框 (- [x]) 与 Session Checkpoint JSON
	 */
	async syncProgress(): Promise<void> {
		if (!this.planPath) return;

		// 1. 同步计划 Markdown 文档中的已勾选任务
		try {
			const mdContent = await readFile(this.planPath, "utf-8");
			const freshUnits = parsePlanUnits(mdContent);
			if (freshUnits.length > 0) {
				this.allUnits = freshUnits;
			}
			for (const u of freshUnits) {
				if (u.checked) {
					this.completedUnits.add(u.id);
				}
			}
		} catch {}

		// 2. 同步 Checkpoint JSON 断点
		try {
			const cpResult = await executeSessionCheckpoint({
				operation: "load",
				repoRoot: this.repoRoot,
				planPath: this.planPath,
				planSlug: this.planSlug || undefined,
			});

			if (cpResult.checkpoint) {
				const cp = cpResult.checkpoint;
				if (cp.completedUnits) {
					for (const raw of cp.completedUnits) {
						const norm = normalizeUnitId(raw, this.allUnits);
						this.completedUnits.add(norm);
					}
				}

				if (cp.failedUnit) {
					this.failedUnit = normalizeUnitId(cp.failedUnit, this.allUnits);
					this.consecutiveFailures += 1;
					this.lastFailureError = cp.error || "测试执行未通过";
					this.failureHistory.push({
						unit: cp.failedUnit,
						error: cp.error,
						timestamp: new Date().toISOString(),
					});
				} else {
					this.consecutiveFailures = 0;
					this.failedUnit = null;
					this.lastFailureError = null;
				}
			}
		} catch {}
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
		this.completedUnits.clear();

		// 同步断点与已勾选单元
		await this.syncProgress();

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
			`3. 验证通过后，【必须立即调用】session_checkpoint({ operation: "save", planPath: "${this.planPath}", completedUnits: ["${status.currentUnit}"] }) 保存断点，或在计划文档对应项勾选 [x]。`,
			`4. 若遇到非预期报错，排查根因。若重试仍失败，调用 session_checkpoint({ operation: "fail", planPath: "${this.planPath}", failedUnit: "${status.currentUnit}", error: "..." })。`,
			`5. 执行完毕后若无致命异常，请直接准备推进下一单元。`,
		].join("\n");
	}

	/**
	 * 在单轮/整段结束 (agent_end) 时主动评估，无缝跨回合排队注入下一单元 (Native Continuous Loop)
	 */
	async onAgentEnd(
		event: { messages: any[] },
		ctx: ExtensionContext,
		pi: ExtensionAPI,
	): Promise<void> {
		if (!this.isActive || !this.planPath) return;

		// 1. 检查中断信号
		const hasAborted =
			ctx.signal?.aborted ||
			event.messages.some((m: any) => m?.role === "assistant" && m?.stopReason === "aborted");
		if (hasAborted) {
			await this.pause("检测到会话中断信号 (Ctrl+C / Esc)");
			ctx.ui?.setStatus?.("workflow", undefined);
			ctx.ui?.notify?.("⏸️ 03-work 自主循环已响应中断信号安全暂停。", "info");
			return;
		}

		// 记录本轮开始前的当前目标
		const currentTarget = this.getStatus().currentUnit;

		// 2. 同步磁盘上的断点与 Markdown 勾选项
		await this.syncProgress();

		// 容错处理：若助手正常结束了本轮任务且未报告错误，但既未调用 session_checkpoint 也未修改 [x]
		// 自动将当前单元标记为完成并同步断点，防止死锁停留在同一单元
		if (currentTarget && !this.completedUnits.has(currentTarget)) {
			const lastAssistant = event.messages
				.slice()
				.reverse()
				.find((m: any) => m?.role === "assistant");

			const isAbortOrError =
				lastAssistant?.stopReason === "aborted" ||
				lastAssistant?.stopReason === "error" ||
				Boolean(this.failedUnit);

			if (!isAbortOrError) {
				this.completedUnits.add(currentTarget);
				// 异步回写 Checkpoint 保存断点，保证断点不丢
				executeSessionCheckpoint({
					operation: "save",
					repoRoot: this.repoRoot,
					planPath: this.planPath,
					planSlug: this.planSlug || undefined,
					completedUnits: Array.from(this.completedUnits),
				}).catch(() => {});
			}
		}

		// 检查遇错即停门禁
		if (this.consecutiveFailures >= 3) {
			await this.pause(
				`硬门禁触发：${this.failedUnit || "当前单元"} 连续排查修复未果 (${this.lastFailureError})，触发 Stop-The-Line 遇错即停保护。`,
			);
			ctx.ui?.notify?.(
				`🛑 03-work 遇到连续失败，已启动遇错即停硬门禁保护，请排查原因。`,
				"error",
			);
			return;
		}

		// 3. 检查是否全部单元均已达成
		const status = this.getStatus();
		if (status.remainingUnits.length === 0) {
			this.isActive = false;
			this.cancelTimer();
			ctx.ui?.setStatus?.("workflow", undefined);
			ctx.ui?.notify?.(
				`🎉 03-work 全部 ${this.allUnits.length} 个规划单元已全部实现并验证通过！自动流转至 04-review 审查阶段。`,
				"info",
			);

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

		// 4. 防失控超轮次保护
		this.currentRunCount += 1;
		if (this.currentRunCount > this.maxRuns) {
			await this.pause(`自主续跑轮次已达安全上限 (${this.maxRuns} 轮)，避免无限死循环。`);
			ctx.ui?.notify?.(
				`⚠️ 03-work 连续执行已达安全上限 (${this.maxRuns} 次)，已暂停。可通过 /skill:03-work 重新恢复。`,
				"warning",
			);
			return;
		}

		// 5. 更新底部状态栏
		const percent = Math.round((status.completedUnits.length / status.allUnits.length) * 100);
		ctx.ui?.setStatus?.(
			"workflow",
			`🔄 03-work 自主干活 [${status.completedUnits.length}/${status.allUnits.length} - ${percent}%] 下一个: ${status.currentUnit}`,
		);

		// 6. 派发下一单元指令
		const nextPrompt = this.generatePromptForNextUnit();
		if (!nextPrompt) return;

		this.cancelTimer();
		// 在 agent_end 中调用 sendUserMessage({ deliverAs: "followUp" })，
		// Pi 底层将把消息放入队列并在 _handlePostAgentRun 中直接循环 continue()，无缝自主续跑！
		try {
			pi.sendUserMessage(nextPrompt, {
				deliverAs: "followUp",
				expandPromptTemplates: true,
			});
			this.continuationDispatched = true;
		} catch {
			this.continuationDispatched = false;
			// 若环境不支持在 agent_end 立即派发，使用延时兜底
			this.timer = setTimeout(() => {
				if (!this.isActive) return;
				pi.sendUserMessage(nextPrompt, {
					deliverAs: "followUp",
					expandPromptTemplates: true,
				});
			}, 100);
			this.timer.unref?.();
		}
	}

	/**
	 * 在 agent_settled 时提供兜底保障，确保如果 agent_end 未能成功排队时继续调度
	 */
	async onAgentSettled(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
		if (!this.isActive || !this.planPath) return;

		// 1. 检查中断信号 (Esc / ctx.signal / 会话内最后一条 assistant aborted)
		if (ctx.signal?.aborted) {
			await this.pause("检测到用户中断信号 (Esc/Abort)");
			ctx.ui?.setStatus?.("workflow", undefined);
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

		// 2. 同步进度
		await this.syncProgress();

		// 3. 检查遇错即停门禁
		if (this.consecutiveFailures >= 3) {
			await this.pause(
				`硬门禁触发：${this.failedUnit || "当前单元"} 连续排查修复未果 (${this.lastFailureError})，触发 Stop-The-Line 遇错即停保护。`,
			);
			ctx.ui?.notify?.(
				`🛑 03-work 遇到连续失败，已启动遇错即停硬门禁保护，请排查原因。`,
				"error",
			);
			return;
		}

		// 4. 检查是否全部单元完成
		const status = this.getStatus();
		if (status.remainingUnits.length === 0) {
			this.isActive = false;
			this.cancelTimer();
			ctx.ui?.setStatus?.("workflow", undefined);
			ctx.ui?.notify?.(
				`🎉 03-work 全部 ${this.allUnits.length} 个规划单元已全部实现并验证通过！自动流转至 04-review 审查阶段。`,
				"info",
			);

			try {
				pi.sendUserMessage(
					"【03-work 全部单元已圆满完成】所有 Implementation Units 测试与验收命令均已绿灯通过。现在自动启动 /skill:04-review 进行最终质量审查与回归核验。",
					{ deliverAs: "followUp", expandPromptTemplates: true },
				);
			} catch {}
			return;
		}

		// 5. 超轮次保护
		this.currentRunCount += 1;
		if (this.currentRunCount > this.maxRuns) {
			await this.pause(`自主续跑轮次已达安全上限 (${this.maxRuns} 轮)，避免无限死循环。`);
			ctx.ui?.setStatus?.("workflow", undefined);
			ctx.ui?.notify?.("⚠️ 03-work 自主续跑已达安全轮次上限已暂停。", "warning");
			return;
		}

		// 如果在 agent_end 中已经成功派发了 continuation，则无需在 settled 中重复发送
		if (this.continuationDispatched) {
			this.continuationDispatched = false;
			return;
		}

		// 6. 如果当前仍处于活跃状态且计时器未启动，补发一次续跑调度 (兜底)
		if (this.isActive && !this.timer) {
			const nextPrompt = this.generatePromptForNextUnit();
			if (!nextPrompt) return;

			this.timer = setTimeout(() => {
				try {
					this.timer = null;
					if (!this.isActive) return;

					pi.sendUserMessage(nextPrompt, {
						deliverAs: "followUp",
						expandPromptTemplates: true,
					});
				} catch (err) {
					console.error("[03-work driver] onAgentSettled fallback failed:", err);
				}
			}, 100);
			this.timer.unref?.();
		}
	}
}
