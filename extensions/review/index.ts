/**
 * Pi 交互式 AI 代码审查扩展 (中文增强版)
 *
 * 参考并融合了 Codex 与 pi-agent-extensions (Armin Ronacher @mitsuhiko) 的经典架构：
 * 采用原生会话与会话分支隔离树技术，支持灵活的双执行引擎：
 * 1. 【单模型原生审查】(默认推荐)：0 依赖、0 网络断流、极速 100% 稳定。
 * 2. 【多 Subagent 并发审查】：支持自由设置并发 2、3、4、5、6 个专家子代理协同会诊。
 *
 * 支持审查模式：
 * - 审查当前未提交的改动 (工作区 + 暂存区)
 * - 审查 GitHub PR (自动通过 gh 本地检出 PR 分支)
 * - 与基准分支 (如 main / master / dev) 进行差分审查
 * - 审查指定的历史 Commit 提交
 * - 审查指定目录或文件快照
 * - 自定义审查要求与重点说明
 *
 * 会话分支隔离：
 * - 默认支持在新分支 (Empty branch) 中开启审查，保持主会话干净
 * - 审查过程中常驻黄色横幅提醒，完成后敲 /review-end
 * - /review-end 自动将审查发现 (P0~P3) 结构化汇总并一键跳回原会话位置，自动填入修复指令
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ExecResult } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

// 跟踪审查会话来源分支节点（保证单次仅一个活跃审查会话）
let reviewOriginId: string | undefined = undefined;

const REVIEW_STATE_TYPE = "review-session";

type ReviewSessionState = {
	active: boolean;
	originId?: string;
};

export interface ReviewSettings {
	/** 模式: "single" (单模型原生审查) | "subagents" (多 Subagent 并发审查) */
	mode: "single" | "subagents";
	/** 并发子代理专家数量 (支持 2, 3, 4, 5, 6) */
	concurrency: number;
	/** 是否启用门禁裁判长总结去重 */
	gateEnabled: boolean;
}

const DEFAULT_SETTINGS: ReviewSettings = {
	mode: "single",
	concurrency: 3,
	gateEnabled: true,
};

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "pi-review.json");

async function loadSettings(): Promise<ReviewSettings> {
	try {
		const raw = await fs.readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw);
		return {
			mode: parsed.mode === "subagents" ? "subagents" : "single",
			concurrency: Math.min(6, Math.max(2, typeof parsed.concurrency === "number" ? parsed.concurrency : 3)),
			gateEnabled: parsed.gateEnabled !== false,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

async function saveSettings(settings: ReviewSettings): Promise<void> {
	try {
		await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
		await fs.writeFile(CONFIG_PATH, JSON.stringify(settings, null, 2), "utf8");
	} catch (err) {
		console.error("保存审查设置失败:", err);
	}
}

interface ReviewExpert {
	id: string;
	label: string;
	desc: string;
	task: string;
}

const ALL_EXPERTS: ReviewExpert[] = [
	{
		id: "pi-review.bugbot",
		label: "Bug 猎手 (Bugbot)",
		desc: "逻辑缺陷、空指针、边界溢出、死锁与运行时崩溃",
		task: "深入排查本次代码改动中的业务逻辑缺陷、空指针、边界异常、并发竞态与未捕获的运行时异常",
	},
	{
		id: "pi-review.security-review",
		label: "安全专家 (Security)",
		desc: "输入参数合法性校验、跨目录边界防护与权限隔离",
		task: "深入排查本次代码改动中的防御性编码缺陷、外部输入未做类型/范围校验、边界防护不足等健壮性隐患",
	},
	{
		id: "pi-review.perf-review",
		label: "性能探针 (Perf)",
		desc: "循环内GC内存分配、CPU热点消耗、算法复杂度与资源泄露",
		task: "深入排查本次代码改动中的性能退化、高频循环内无谓内存分配 (GC压力) 与算法复杂度",
	},
	{
		id: "pi-review.claude-md-compliance",
		label: "契约合规 (Compliance)",
		desc: "架构契约、设计模式、模块边界与规范遵循",
		task: "排查本次代码改动是否违反项目既有架构契约、模块封装规范与规范指南",
	},
	{
		id: "pi-review.code-comments",
		label: "注释与可读性 (Comments)",
		desc: "注释与代码逻辑倒挂、误导性命名与维护性隐患",
		task: "排查本次代码改动中的可读性隐患、注释与逻辑不符、误导性命名与维护风险",
	},
	{
		id: "pi-review.history-context",
		label: "历史脉络 (History)",
		desc: "结合 Git 历史演进判断意图，防止历史问题回归",
		task: "结合代码演变历史，排查本次改动是否破坏既有历史契约或重现已知缺陷",
	},
];

function buildSubagentOrchestrationPrompt(
	concurrency: number,
	gateEnabled: boolean,
	targetInstruction: string,
): string {
	const count = Math.min(6, Math.max(2, concurrency));
	const selected = ALL_EXPERTS.slice(0, count);

	const listText = selected.map((exp, idx) => `${idx + 1}. **${exp.label}** (\`${exp.id}\`)：${exp.desc}`).join("\n");
	const callsExample = selected
		.map((exp) => {
			const fullTask = `${targetInstruction}\n\n【专项排查分工】：${exp.task}`;
			return `subagent({ agent: ${JSON.stringify(exp.id)}, task: ${JSON.stringify(fullTask)} });`;
		})
		.join("\n");

	const maxBackticks = (callsExample.match(/`+/g) || []).reduce((max, m) => Math.max(max, m.length), 2);
	const fence = "`".repeat(maxBackticks + 1);

	return `## 🚀 执行方式：多 Subagent 并发专家审查 (当前配置并发数: ${count} 个专家)

当前已配置并行启动以下 ${count} 个专家子代理进行分工审查：

${listText}

### 协作审查执行规范：
1. **并发调用子代理**：请在当前回合使用 \`subagent\` 工具**同时并行唤起**上述 ${count} 个专家子代理（单回合发起 ${count} 个并发 tool_call，严禁串行逐个调用）：
${fence}js
${callsExample}
${fence}
2. **主审裁判长汇总整理**：当所有专家子代理执行完毕返回发现后，请你作为主审裁判长${gateEnabled ? "（门禁裁决）" : ""}：
   - 全面综合各专家的审查意见，对相同问题进行去重，剔除误报和低置信度内容（注意：项目中合法的内部 GM / Debug 调试工具在确保与正式生产环境隔离的前提下免检）。
   - 严格按照《核心代码审查准则》的 **[P0~P3]** 等级标准排布审查清单。
   - 给出最终综合裁决与一句话中文总评。
3. **语言强制要求**：所有任务入参、思考分析过程、综合汇报与最终报告必须 100% 为纯正中文，严禁出现任何英文段落或未翻译小标题！`;
}

function setReviewWidget(ctx: ExtensionContext, active: boolean) {
	if (!ctx.hasUI) return;
	if (!active) {
		ctx.ui.setWidget("review", undefined);
		return;
	}

	ctx.ui.setWidget("review", (_tui, theme) => {
		const text = new Text(theme.fg("warning", "🔍 代码审查分支进行中，审查完毕后输入 /review-end 返回主对话"), 0, 0);
		return {
			render(width: number) {
				return text.render(width);
			},
			invalidate() {
				text.invalidate();
			},
		};
	});
}

function getReviewState(ctx: ExtensionContext): ReviewSessionState | undefined {
	let state: ReviewSessionState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === REVIEW_STATE_TYPE) {
			state = entry.data as ReviewSessionState | undefined;
		}
	}
	return state;
}

function applyReviewState(ctx: ExtensionContext) {
	const state = getReviewState(ctx);
	if (state?.active && state.originId) {
		reviewOriginId = state.originId;
		setReviewWidget(ctx, true);
		return;
	}

	reviewOriginId = undefined;
	setReviewWidget(ctx, false);
}

// 审查目标类型
type ReviewTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string }
	| { type: "commit"; sha: string; title?: string }
	| { type: "custom"; instructions: string }
	| { type: "pullRequest"; prNumber: number; baseBranch: string; title: string }
	| { type: "folder"; paths: string[] };

// 针对不同审查目标的中文提示词
const LITE_REVIEW_PROMPT =
	"【极速体检模式】请首先运行 `git diff` 获取代码改动，并针对改动涉及的核心函数按需使用 `read` 查阅周边上下文（如所在完整方法实现与生命周期），快速排查高危逻辑异常、运行时崩溃与防御性缺陷。注意：项目中内部 GM/Debug 调试工具在确认与生产环境隔离的前提下免检，切勿误判；但若正式生产包可直接触达仍属漏洞。结合上下文精准核验后直接输出审查发现。严禁输出任何步骤清单。所有输出必须使用纯正中文。";

const FULL_REVIEW_PROMPT =
	"【全量深度审查模式】请对当前代码改动展开深度的上下文关联审查：首先运行 `git diff` 全量查阅改动，必须使用 `read` / `grep` 深入查阅改动方法所在的完整类定义、调用方契约、状态机与生命周期等关键上下文，深入排查业务逻辑隐患、边界异常、并发安全、性能GC开销与架构契约。注意：项目中内部 GM 调试面板与测试辅助逻辑在已隔离于正式生产包的前提下免检，切勿误判。结合完整代码脉络直接输出详尽审查清单。严禁输出任何步骤清单。所有输出必须使用纯正中文。";

const UNCOMMITTED_PROMPT =
	"请审查当前代码的所有改动（包含暂存区、未暂存区以及新增文件）。先运行 `git diff` 与 `git status` 获取改动，再针对关键改动按需使用 `read` / `grep` 查阅周边上下文代码与调用链路，排查真实业务缺陷与边界异常（注意：项目中内部 GM/Debug 调试指令在与生产环境隔离的前提下属于正常研发代码，勿误判），结合完整上下文直接输出审查发现。严禁输出任何步骤清单或待办列表。所有输出必须使用纯正中文。";

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
	"请审查当前分支相对于基准分支 '{baseBranch}' 的改动（合并基准 commit: {mergeBaseSha}）。运行 `git diff {mergeBaseSha}` 查看改动，并按需使用 `read` / `grep` 结合周边上下文深入分析，直接输出审查发现。严禁输出任何步骤清单。所有输出必须使用纯正中文。";

const BASE_BRANCH_PROMPT_FALLBACK =
	"请审查当前分支相对于基准分支 '{branch}' 的改动。先使用 `git merge-base` 与 `git diff` 查看改动，并按需使用 `read` / `grep` 结合周边上下文深入分析，直接输出审查发现。严禁输出任何步骤清单。所有输出必须使用纯正中文。";

const COMMIT_PROMPT_WITH_TITLE =
	'请审查提交 commit {sha} ("{title}") 引入的代码改动。运行 `git show {sha}` 查看差异，并按需使用 `read` / `grep` 结合周边上下文深入分析，直接输出审查发现。严禁输出任何步骤清单。所有输出必须使用纯正中文。';

const COMMIT_PROMPT =
	"请审查提交 commit {sha} 引入的代码改动。运行 `git show {sha}` 查看差异，并按需使用 `read` / `grep` 结合周边上下文深入分析，直接输出审查发现。严禁输出任何步骤清单。所有输出必须使用纯正中文。";

const PULL_REQUEST_PROMPT =
	'请审查 Pull Request #{prNumber} ("{title}") 相对于基准分支 \'{baseBranch}\' 的改动（合并基准 commit: {mergeBaseSha}）。运行 `git diff {mergeBaseSha}` 查看改动，并按需使用 `read` / `grep` 结合周边上下文深入分析，直接输出审查发现。严禁输出任何步骤清单。所有输出必须使用纯正中文。';

const PULL_REQUEST_PROMPT_FALLBACK =
	'请审查 Pull Request #{prNumber} ("{title}") 相对于基准分支 \'{baseBranch}\' 的改动。先运行 `git diff` 查看改动，并按需使用 `read` / `grep` 结合周边上下文深入分析，直接输出审查发现。严禁输出任何步骤清单。所有输出必须使用纯正中文。';

const FOLDER_REVIEW_PROMPT =
	"请对以下目录/文件路径的代码进行快照审查：{paths}。直接读取这些文件并结合上下文直接输出审查发现。严禁输出任何步骤清单。所有输出必须使用纯正中文。";

// 权威的中文代码审查准则 (基于 Codex 准则精炼与本土化)
const REVIEW_RUBRIC = `> 🚨【最高执行原则】：
> 1. **全流程纯中文**：思维链（Thinking）、推理分析与最终报告必须 100% 使用纯正中文，严禁包含任何英文段落或英文小标题！
> 2. **结合上下文，拒绝断章取义**：仅看 diff 的片段容易产生误判。请**先运行 \`git diff\` 锁定变动，再针对改动涉及的关键方法、类生命周期或调用方，按需使用 \`read\` 或 \`grep\` 查阅必要的上下文代码**（精准核验，切勿无目的漫游遍历），结合真实完整的业务上下文做出准确裁决！
> 3. **直接审查，拒绝繁琐步骤**：严禁打印任何工作流待办清单（Checklist）或环境测试命令！

# 核心代码审查准则

你是一名资深技术专家，正在审查提交的代码改动。请结合完整代码上下文，直击本质，拦截真实缺陷：

## 重点排查范围
1. **代码正确性与边界**：结合函数整体逻辑与调用方，排查业务逻辑缺陷、空指针/未定义引用、边界越界、生命周期异常、未捕获的运行时崩溃。
2. **并发与状态安全**：结合上下文状态机与生命周期，排查竞态条件、死锁隐患、异步缺少等待、脏状态残留。
3. **性能与内存开销**：高频主循环内的大量堆内存分配 (GC 压力)、不必要的深拷贝、高复杂度算法、资源句柄泄露。
4. **输入验证与安全边界**：外部未受信任输入是否缺乏合法性检查、参数未做参数化转义、类型断言与长度/范围限制，是否存在跨目录访问或越权风险。
5. **只关注本次改动**：严禁将改动前既有的历史代码当作本次改动的缺陷。

## 严格过滤误报
- ❌ 严禁提出吹毛求疵、纯属个人审美的风格建议。
- ❌ 严禁提出 Linter / 类型检查器会自动捕获的浅层格式建议。
- ❌ 严禁脱离上下文进行无端猜测，每条问题必须有明确的代码与上下文事实证据。
- 💡 **开发与测试工具免检准则**：在游戏、客户端与业务系统中，\`GM\`（Game Master/内部调试面板）、\`Debug\` 指令、测试出战模拟等属于受信任的研发辅助逻辑，**在通过编译宏（如 \`#if UNITY_EDITOR || DEVELOPMENT_BUILD\`）或环境判断已隔离于正式生产环境的前提下，严禁将其误判为安全漏洞或缺陷**；但若此类入口在正式生产发布包中无防护可被客户端或外部请求触达，仍属 P0 安全隐患，必须报告。

## 缺陷等级标记 [P0~P3]
- **[P0 - 致命阻塞]** 崩溃、死锁、数据损坏、关键功能不可用，必须阻断合并
- **[P1 - 紧急待修]** 明确逻辑缺陷、边界异常、严重性能退化，合并前需修复
- **[P2 - 普通建议]** 局部的健壮性隐患、轻度设计问题
- **[P3 - 细节优化]** 细节优化与可读性

## 输出格式规范（直接输出，无多余寒暄与准备动作）
### 审查发现清单
每个问题按以下格式列出（若无存活缺陷，明确输出：\`未发现存活的代码缺陷，代码质量良好，建议合并。\`）：
- **[P0|P1|P2|P3] 简短标题**：\`文件路径:行号\`
  - **缺陷说明**：结合上下文简明说明后果与触发场景。
  - **代码证据**：引用关键代码及上下文。
  - **修改建议**：给出最小化修复思路或代码替换块（可使用 \`\`\`suggestion）。

### 综合裁决
- **最终结论**：\`通过\` 或 \`需要修改 (存在 P0/P1 阻塞问题)\`
- **总结说明**：一句话中文总评。`;

/**
 * 尝试加载项目本地的专属审查准则文件 (仅加载专用的 REVIEW_GUIDELINES.md)
 */
async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
	let currentDir = path.resolve(cwd);

	while (true) {
		const piDir = path.join(currentDir, ".pi");
		const guidelinePath = path.join(currentDir, "REVIEW_GUIDELINES.md");

		const piStats = await fs.stat(piDir).catch(() => null);
		if (piStats?.isDirectory()) {
			const stat = await fs.stat(guidelinePath).catch(() => null);
			if (stat?.isFile()) {
				try {
					const content = await fs.readFile(guidelinePath, "utf8");
					const trimmed = content.trim();
					if (trimmed) {
						if (trimmed.length <= 12000) return trimmed;
						const lastNewline = trimmed.lastIndexOf("\n", 12000);
						const cutoff = lastNewline > 2000 ? lastNewline : 12000;
						return `${trimmed.slice(0, cutoff).trimEnd()}\n\n> 💡 *(注：项目专属审查规范篇幅较长，已安全截取前置 12000 字符)*`;
					}
				} catch {
					/* ignore */
				}
			}
			return null;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * 判断当前审查会话是否被有效锁定
 */
function isSessionLocked(ctx: ExtensionContext): boolean {
	if (!reviewOriginId) return false;
	const state = getReviewState(ctx);

	// 状态未激活说明会话已结束或锁已失效，自动释放
	if (!state?.active) {
		reviewOriginId = undefined;
		setReviewWidget(ctx, false);
		return false;
	}
	return true;
}

interface SafeExecOptions {
	cwd?: string;
	timeoutMs?: number;
}

/**
 * 带超时与异常保护的安全外部命令执行包装 (原生类型安全，支持 AbortController 信号取消与 cwd)
 */
async function safeExec(
	pi: ExtensionAPI,
	cmd: string,
	args: string[],
	options: SafeExecOptions | number = 25000,
): Promise<ExecResult> {
	const opts = typeof options === "number" ? { timeoutMs: options } : options;
	const timeoutMs = opts.timeoutMs ?? 25000;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<ExecResult>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error(`命令执行超时 (${timeoutMs}ms): ${cmd} ${args.join(" ")}`));
		}, timeoutMs);
	});
	try {
		// pi.exec 原生支持 ExecOptions: { signal?: AbortSignal, timeout?: number, cwd?: string }
		// 超时后 controller.abort() 会由 SDK 底层 execCommand 原生杀死子进程
		const execPromise = pi.exec(cmd, args, {
			signal: controller.signal,
			timeout: timeoutMs,
			cwd: opts.cwd,
		});
		return await Promise.race([execPromise, timeoutPromise]);
	} catch (err) {
		return {
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			code: -1,
			killed: true,
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * 获取 HEAD 与指定分支的 merge base (支持本地分支、跟踪分支及远程分支)
 */
async function getMergeBase(pi: ExtensionAPI, branch: string): Promise<string | null> {
	try {
		// 1. 尝试跟踪分支的 upstream
		const { stdout: upstream, code: upstreamCode } = await safeExec(pi, "git", [
			"rev-parse",
			"--abbrev-ref",
			`${branch}@{upstream}`,
		], 8000);

		if (upstreamCode === 0 && upstream.trim()) {
			const { stdout: mergeBase, code } = await safeExec(pi, "git", ["merge-base", "HEAD", upstream.trim()], 8000);
			if (code === 0 && mergeBase.trim()) return mergeBase.trim();
		}

		// 2. 尝试本地分支或已显式包含远程前缀的分支 (如 upstream/main、origin/main)
		const { stdout: directBase, code: directCode } = await safeExec(pi, "git", ["merge-base", "HEAD", branch], 8000);
		if (directCode === 0 && directBase.trim()) return directBase.trim();

		// 3. 若分支未显式带 origin/ 前缀且本地未找到，尝试 origin/ 前缀兜底（兼容未检出本地分支或浅克隆，例如 feature/login -> origin/feature/login）
		if (!branch.startsWith("origin/")) {
			const { stdout: remoteBase, code: remoteCode } = await safeExec(pi, "git", ["merge-base", "HEAD", `origin/${branch}`], 8000);
			if (remoteCode === 0 && remoteBase.trim()) return remoteBase.trim();
		}

		return null;
	} catch {
		return null;
	}
}

async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await safeExec(pi, "git", ["branch", "--format=%(refname:short)"], 8000);
	if (code !== 0) return [];
	return stdout
		.trim()
		.split("\n")
		.map((b) => b.trim())
		.filter(Boolean);
}

async function getRecentCommits(pi: ExtensionAPI, limit = 20): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await safeExec(pi, "git", ["log", "--oneline", "-n", `${limit}`], 8000);
	if (code !== 0) return [];

	return stdout
		.trim()
		.split("\n")
		.map((line) => {
			const spaceIdx = line.indexOf(" ");
			if (spaceIdx === -1) return { sha: line, title: "" };
			return {
				sha: line.slice(0, spaceIdx),
				title: line.slice(spaceIdx + 1).trim(),
			};
		})
		.filter((c) => c.sha.length > 0);
}

async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await safeExec(pi, "git", ["status", "--porcelain"], 8000);
	// 若检测超时或异常 (code === -1)，避免报出“工作区干净”的假阴性，按有改动处理 (fail-open)
	if (code === -1) return true;
	return code === 0 && stdout.trim().length > 0;
}

async function hasPendingChanges(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await safeExec(pi, "git", ["status", "--porcelain"], 8000);
	if (code === -1) return true; // 超时降级放行
	if (code !== 0) return false;
	const lines = stdout.trim().split("\n").filter((line) => line.trim());
	const trackedChanges = lines.filter((line) => !line.startsWith("??"));
	return trackedChanges.length > 0;
}

function parsePrReference(ref: string): number | null {
	const trimmed = ref.trim();
	const num = Number.parseInt(trimmed, 10);
	if (!Number.isNaN(num) && num > 0) return num;

	const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
	if (urlMatch) return Number.parseInt(urlMatch[1], 10);
	return null;
}

async function getPrInfo(
	pi: ExtensionAPI,
	prNumber: number,
): Promise<{ baseBranch: string; title: string; headBranch: string } | null> {
	try {
		const { stdout, code } = await safeExec(pi, "gh", [
			"pr",
			"view",
			String(prNumber),
			"--json",
			"baseRefName,title,headRefName",
		], 15000);
		if (code !== 0) return null;

		const data = JSON.parse(stdout);
		return {
			baseBranch: data.baseRefName,
			title: data.title,
			headBranch: data.headRefName,
		};
	} catch {
		return null;
	}
}

async function checkoutPr(pi: ExtensionAPI, prNumber: number): Promise<{ success: boolean; error?: string }> {
	const { stdout, stderr, code } = await safeExec(pi, "gh", ["pr", "checkout", String(prNumber)], 30000);
	if (code !== 0) {
		return { success: false, error: stderr || stdout || "检出 PR 分支失败" };
	}
	return { success: true };
}

async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await safeExec(pi, "git", ["branch", "--show-current"], 8000);
	if (code === 0 && stdout.trim()) return stdout.trim();
	return null;
}

async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
	const { stdout, code } = await safeExec(pi, "git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], 8000);
	if (code === 0 && stdout.trim()) {
		return stdout.trim().replace("origin/", "");
	}
	const branches = await getLocalBranches(pi);
	if (branches.includes("main")) return "main";
	if (branches.includes("master")) return "master";
	return "main";
}

async function buildReviewPrompt(
	pi: ExtensionAPI,
	target: ReviewTarget,
	reviewStyle: "lite" | "full" | "standard" = "standard",
): Promise<string> {
	switch (target.type) {
		case "uncommitted":
			if (reviewStyle === "lite") return LITE_REVIEW_PROMPT;
			if (reviewStyle === "full") return FULL_REVIEW_PROMPT;
			return UNCOMMITTED_PROMPT;

		case "baseBranch": {
			const mergeBase = await getMergeBase(pi, target.branch);
			if (mergeBase) {
				return BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replace(/{baseBranch}/g, target.branch).replace(
					/{mergeBaseSha}/g,
					mergeBase,
				);
			}
			return BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch);
		}

		case "commit":
			if (target.title) {
				return COMMIT_PROMPT_WITH_TITLE.replace("{sha}", target.sha).replace("{title}", target.title);
			}
			return COMMIT_PROMPT.replace("{sha}", target.sha);

		case "custom":
			return `审查代码并重点满足以下定制要求：${target.instructions}。所有输出必须使用纯正中文。`;

		case "pullRequest": {
			const mergeBase = await getMergeBase(pi, target.baseBranch);
			if (mergeBase) {
				return PULL_REQUEST_PROMPT.replace(/{prNumber}/g, String(target.prNumber))
					.replace(/{title}/g, target.title)
					.replace(/{baseBranch}/g, target.baseBranch)
					.replace(/{mergeBaseSha}/g, mergeBase);
			}
			return PULL_REQUEST_PROMPT_FALLBACK.replace(/{prNumber}/g, String(target.prNumber))
				.replace(/{title}/g, target.title)
				.replace(/{baseBranch}/g, target.baseBranch);
		}

		case "folder":
			return FOLDER_REVIEW_PROMPT.replace("{paths}", target.paths.join(", "));
	}
}

function getUserFacingHint(target: ReviewTarget): string {
	switch (target.type) {
		case "uncommitted":
			return "当前未提交改动 (工作区 + 暂存区)";
		case "baseBranch":
			return `与分支 '${target.branch}' 的改动对比`;
		case "commit": {
			const shortSha = target.sha.slice(0, 7);
			return target.title ? `提交 ${shortSha}: ${target.title}` : `提交 ${shortSha}`;
		}
		case "custom":
			return target.instructions.length > 40 ? `${target.instructions.slice(0, 37)}...` : target.instructions;
		case "pullRequest": {
			const shortTitle = target.title.length > 30 ? `${target.title.slice(0, 27)}...` : target.title;
			return `PR #${target.prNumber}: ${shortTitle}`;
		}
		case "folder": {
			const joined = target.paths.join(", ");
			return joined.length > 40 ? `目录: ${joined.slice(0, 37)}...` : `目录: ${joined}`;
		}
	}
}

// 审查预设模式选项清单
const REVIEW_PRESETS = [
	{ value: "uncommitted", label: "审查未提交改动", description: "(当前工作区已暂存 + 未暂存代码)" },
	{ value: "baseBranch", label: "与基准分支对比审查", description: "(如与 main / master 分支对比)" },
	{ value: "commit", label: "审查指定提交", description: "(从最近提交记录中挑选)" },
	{ value: "pullRequest", label: "审查 Pull Request", description: "(输入 PR 编号或 GitHub URL 本地检出)" },
	{ value: "folder", label: "审查指定目录/文件", description: "(静态快照审查，非 diff)" },
	{ value: "custom", label: "自定义审查要求", description: "(输入针对性的安全/性能侧重点)" },
	{ value: "config", label: "⚙️ 审查配置中心", description: "(切换单模型 / 多Subagent并发 2~6个)" },
] as const;

/**
 * 弹出交互式审查配置界面
 */
async function showConfigDialog(ctx: ExtensionContext): Promise<void> {
	const settings = await loadSettings();

	while (true) {
		const modeDesc = settings.mode === "single" ? "单模型直接审查 (极速 100% 稳定)" : `多 Subagent 并发 (${settings.concurrency} 个专家)`;
		const gateDesc = settings.gateEnabled ? "开启" : "关闭";

		const menuItems: SelectItem[] = [
			{
				value: "toggle-mode",
				label: `1. 审查引擎: [${settings.mode === "single" ? "单模型直接审查" : "多Subagent并发"}]`,
				description: modeDesc,
			},
			{
				value: "concurrency",
				label: `2. 并发子代理数: [${settings.concurrency} 个专家]`,
				description: "可自由设置并发 2、3、4、5、6 个专家子代理",
			},
			{
				value: "gate",
				label: `3. 门禁裁判长去重: [${gateDesc}]`,
				description: "在多专家返回后由主审裁判长汇总去重并定级",
			},
			{
				value: "save",
				label: "✅ 保存配置并退出",
				description: "将当前设置保存到 ~/.pi/agent/pi-review.json",
			},
		];

		const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("⚙️  代码审查配置中心"))));

			const selectList = new SelectList(menuItems, menuItems.length, {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "方向键选择 • 回车修改/确认 • ESC 取消")));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render(w) { return container.render(w); },
				invalidate() { container.invalidate(); },
				handleInput(d) { selectList.handleInput(d); tui.requestRender(); },
			};
		});

		if (choice === null) {
			ctx.ui.notify("已取消，未保存审查设置修改。", "info");
			return;
		}

		if (choice === "save") {
			await saveSettings(settings);
			ctx.ui.notify(`已保存审查设置：${settings.mode === "single" ? "单模型直接审查" : `多Subagent模式 (${settings.concurrency} 并发)`}`, "info");
			return;
		}

		if (choice === "toggle-mode") {
			settings.mode = settings.mode === "single" ? "subagents" : "single";
		} else if (choice === "concurrency") {
			const concurrencyChoice = await ctx.ui.select(
				"请选择并发 Subagent 专家数量 (2 ~ 6 个)：",
				[
					"2 个专家 (Bug猎手 + 安全专家 · 轻量低延迟)",
					"3 个专家 (Bug猎手 + 安全专家 + 性能探针 · 均衡推荐)",
					"4 个专家 (+ 契约规范合规)",
					"5 个专家 (+ 注释与代码可读性)",
					"6 个专家 (全量 6 大专家深度会诊)",
				]
			);
			if (concurrencyChoice !== undefined) {
				const num = Number.parseInt(concurrencyChoice.slice(0, 1), 10);
				if (num >= 2 && num <= 6) {
					settings.concurrency = num;
				}
			}
		} else if (choice === "gate") {
			settings.gateEnabled = !settings.gateEnabled;
		}
	}
}

export default function reviewExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		applyReviewState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		applyReviewState(ctx);
	});

	async function getSmartDefault(): Promise<"uncommitted" | "baseBranch" | "commit"> {
		if (await hasUncommittedChanges(pi)) {
			return "uncommitted";
		}
		const currentBranch = await getCurrentBranch(pi);
		const defaultBranch = await getDefaultBranch(pi);
		if (currentBranch && currentBranch !== defaultBranch) {
			return "baseBranch";
		}
		return "commit";
	}

	async function showReviewSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const smartDefault = await getSmartDefault();
		const currentSettings = await loadSettings();

		while (true) {
			const modeTag = currentSettings.mode === "single" ? "单模型模式" : `${currentSettings.concurrency} 专家并发`;
			const items: SelectItem[] = REVIEW_PRESETS.slice()
				.sort((a, b) => {
					if (a.value === "config") return 1;
					if (b.value === "config") return -1;
					if (a.value === smartDefault) return -1;
					if (b.value === smartDefault) return 1;
					return 0;
				})
				.map((preset) => ({
					value: preset.value,
					label: preset.label,
					description: preset.value === "config" ? `[当前: ${modeTag}]` : preset.description,
				}));

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
				container.addChild(new Text(theme.fg("accent", theme.bold(`请选择代码审查模式 [${modeTag}]`))));

				const selectList = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});

				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(null);

				container.addChild(selectList);
				container.addChild(new Text(theme.fg("dim", "回车确认 • ESC 取消")));
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			});

			if (!result) return null;

			if (result === "config") {
				await showConfigDialog(ctx);
				// 重新加载配置并循环展示主菜单
				const updated = await loadSettings();
				currentSettings.mode = updated.mode;
				currentSettings.concurrency = updated.concurrency;
				currentSettings.gateEnabled = updated.gateEnabled;
				continue;
			}

			switch (result) {
				case "uncommitted":
					return { type: "uncommitted" };

				case "baseBranch": {
					const target = await showBranchSelector(ctx);
					if (target) return target;
					break;
				}

				case "commit": {
					const target = await showCommitSelector(ctx);
					if (target) return target;
					break;
				}

				case "custom": {
					const target = await showCustomInput(ctx);
					if (target) return target;
					break;
				}

				case "folder": {
					const target = await showFolderInput(ctx);
					if (target) return target;
					break;
				}

				case "pullRequest": {
					const target = await showPrInput(ctx);
					if (target) return target;
					break;
				}

				default:
					return null;
			}
		}
	}

	async function showBranchSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const branches = await getLocalBranches(pi);
		const defaultBranch = await getDefaultBranch(pi);

		if (branches.length === 0) {
			ctx.ui.notify("未找到任何本地分支", "error");
			return null;
		}

		const sortedBranches = branches.sort((a, b) => {
			if (a === defaultBranch) return -1;
			if (b === defaultBranch) return 1;
			return a.localeCompare(b);
		});

		const items: SelectItem[] = sortedBranches.map((branch) => ({
			value: branch,
			label: branch,
			description: branch === defaultBranch ? "(默认主分支)" : "",
		}));

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("请选择要对比的基准分支"))));

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "输入关键词可快速搜索 • 回车选择 • ESC 取消")));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!result) return null;
		return { type: "baseBranch", branch: result };
	}

	async function showCommitSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const commits = await getRecentCommits(pi, 20);

		if (commits.length === 0) {
			ctx.ui.notify("未找到最近的提交记录", "error");
			return null;
		}

		const items: SelectItem[] = commits.map((commit) => ({
			value: commit.sha,
			label: `${commit.sha.slice(0, 7)} ${commit.title}`,
			description: "",
		}));

		const result = await ctx.ui.custom<{ sha: string; title: string } | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("请选择要审查的 Commit"))));

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			selectList.onSelect = (item) => {
				const commit = commits.find((c) => c.sha === item.value);
				done(commit || null);
			};
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "输入可搜索 • 回车选择 • ESC 取消")));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!result) return null;
		return { type: "commit", sha: result.sha, title: result.title };
	}

	async function showCustomInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const result = await ctx.ui.editor(
			"请输入本次审查的具体要求与侧重点 (如并发安全、GC开销、特定接口逻辑)：",
			"重点排查潜在的并发死锁、内存泄露以及外部输入合法性校验...",
		);

		if (!result?.trim()) return null;
		return { type: "custom", instructions: result.trim() };
	}

	function parseReviewPaths(value: string): string[] {
		return value
			.split(/\s+/)
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}

	async function showFolderInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const result = await ctx.ui.editor(
			"请输入要审查的文件或目录路径 (多个路径使用空格或换行分隔)：",
			".",
		);

		if (!result?.trim()) return null;
		const paths = parseReviewPaths(result);
		if (paths.length === 0) return null;

		return { type: "folder", paths };
	}

	async function handlePrCheckout(ctx: ExtensionContext, prRef: string): Promise<ReviewTarget | null> {
		if (await hasPendingChanges(pi)) {
			ctx.ui.notify("无法检出 PR：工作区存在未提交改动，请先提交或暂存 (git stash)。", "error");
			return null;
		}

		const prNumber = parsePrReference(prRef);
		if (!prNumber) {
			ctx.ui.notify("无效的 PR 格式，请输入纯数字编号或 GitHub PR 网页链接。", "error");
			return null;
		}

		ctx.ui.notify(`正在获取 PR #${prNumber} 元数据...`, "info");
		const prInfo = await getPrInfo(pi, prNumber);

		if (!prInfo) {
			ctx.ui.notify(`未找到 PR #${prNumber}。请确认已登录 gh (GitHub CLI) 且 PR 存在。`, "error");
			return null;
		}

		ctx.ui.notify(`正在本地检出 PR #${prNumber} 分支...`, "info");
		const checkoutResult = await checkoutPr(pi, prNumber);

		if (!checkoutResult.success) {
			ctx.ui.notify(`检出 PR 失败: ${checkoutResult.error}`, "error");
			return null;
		}

		ctx.ui.notify(`已成功检出 PR #${prNumber} (${prInfo.headBranch})`, "info");

		return {
			type: "pullRequest",
			prNumber,
			baseBranch: prInfo.baseBranch,
			title: prInfo.title,
		};
	}

	async function showPrInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		if (await hasPendingChanges(pi)) {
			ctx.ui.notify("无法检出 PR：工作区存在未提交改动，请先提交或暂存 (git stash)。", "error");
			return null;
		}

		const prRef = await ctx.ui.editor(
			"请输入 PR 编号或 GitHub URL (如 123 或 https://github.com/owner/repo/pull/123)：",
			"",
		);

		if (!prRef?.trim()) return null;
		return handlePrCheckout(ctx, prRef.trim());
	}

	async function executeReview(
		ctx: ExtensionCommandContext,
		target: ReviewTarget,
		useFreshSession: boolean,
		runtimeSettings?: Partial<ReviewSettings>,
		reviewStyle: "lite" | "full" | "standard" = "standard",
	): Promise<void> {
		if (isSessionLocked(ctx)) {
			ctx.ui.notify("当前已有正在进行的审查会话。请使用 /review-end 结束，或输入 /review-reset 强制重置。", "warning");
			return;
		}

		// 1. 前置预检：未提交改动预检，避免在空工作区盲目启动导致模型困惑或误报
		if (target.type === "uncommitted") {
			const hasChanges = await hasUncommittedChanges(pi);
			if (!hasChanges) {
				ctx.ui.notify("当前工作区没有检测到任何未提交的代码改动 (工作区与暂存区均干净)。", "info");
				return;
			}
		}

		// 2. 前置预检：分支对比预检
		if (target.type === "baseBranch") {
			const mergeBase = await getMergeBase(pi, target.branch);
			if (mergeBase) {
				const { stdout: diffStat, code: diffCode } = await safeExec(pi, "git", ["diff", "--stat", mergeBase], 10000);
				if (diffCode === 0 && !diffStat.trim()) {
					ctx.ui.notify(`当前分支相对于基准分支 '${target.branch}' 没有检测到任何差异改动。`, "info");
					return;
				}
			}
		}

		const baseSettings = await loadSettings();
		const settings: ReviewSettings = {
			...baseSettings,
			...runtimeSettings,
		};

		let effectiveFreshSession = useFreshSession;

		if (effectiveFreshSession) {
			const originId = ctx.sessionManager.getLeafId() ?? undefined;
			const entries = ctx.sessionManager.getEntries();
			const firstUserMessage = entries.find((e) => e.type === "message" && e.message.role === "user");

			// 若当前会话已有用户消息，则切出独立审查分支
			if (firstUserMessage && originId) {
				const lockedOriginId = originId;
				let navigated = false;
				try {
					const result = await ctx.navigateTree(firstUserMessage.id, { summarize: false, label: "代码审查" });
					if (result.cancelled) {
						reviewOriginId = undefined;
						return;
					}
					navigated = true;
					reviewOriginId = lockedOriginId;
					ctx.ui.setEditorText("");
					pi.appendEntry(REVIEW_STATE_TYPE, { active: true, originId: lockedOriginId });
					setReviewWidget(ctx, true);
				} catch (error) {
					reviewOriginId = undefined;
					effectiveFreshSession = false;
					setReviewWidget(ctx, false);
					const msg = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(
						navigated
							? `已切入审查分支，但状态记录失败: ${msg}。审查结束后请用 /sessions 手动切回主会话。`
							: `切入审查分支失败: ${msg}，降级为在当前会话执行。`,
						"warning",
					);
				}
			} else {
				// 当前会话原本就是空白会话，无需切分支，直接在当前会话执行
				effectiveFreshSession = false;
				reviewOriginId = undefined;
				setReviewWidget(ctx, false);
			}
		}

		const prompt = await buildReviewPrompt(pi, target, reviewStyle);
		const hint = getUserFacingHint(target);
		const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);

		let fullPrompt = REVIEW_RUBRIC;

		if (settings.mode === "subagents") {
			fullPrompt += `\n\n---\n\n${buildSubagentOrchestrationPrompt(settings.concurrency, settings.gateEnabled, prompt)}`;
		}

		fullPrompt += `\n\n---\n\n## 本次审查任务指示\n\n${prompt}`;

		if (projectGuidelines) {
			fullPrompt += `\n\n## 本项目附加规范指南\n\n${projectGuidelines}`;
		}

		const styleTag = reviewStyle === "lite" ? "[极速]" : reviewStyle === "full" ? "[全量]" : "";
		const modeLabel = settings.mode === "single" ? "单模型模式" : `多Subagent并发(${settings.concurrency}专家)`;
		const modeHint = effectiveFreshSession ? " (独立审查分支)" : "";
		ctx.ui.notify(`正在启动代码审查 ${styleTag}: ${hint}${modeHint} [${modeLabel}]`, "info");

		pi.sendUserMessage(fullPrompt);
	}

	function parseArgs(args: string | undefined): {
		target: ReviewTarget | { type: "pr"; ref: string } | null;
		settingsOverride: Partial<ReviewSettings>;
	} {
		const settingsOverride: Partial<ReviewSettings> = {};
		if (!args?.trim()) return { target: null, settingsOverride };

		const rawParts = args.trim().split(/\s+/);
		const parts: string[] = [];

		for (let i = 0; i < rawParts.length; i++) {
			const p = rawParts[i];
			if (p === "--subagents" || p === "-s") {
				settingsOverride.mode = "subagents";
			} else if (p === "--single") {
				settingsOverride.mode = "single";
			} else if (p === "--concurrency" || p === "-c") {
				const next = rawParts[i + 1];
				if (next) {
					const num = Number.parseInt(next, 10);
					if (!Number.isNaN(num)) {
						settingsOverride.concurrency = Math.min(6, Math.max(2, num));
						settingsOverride.mode = "subagents";
					}
					i++;
					continue;
				}
			} else {
				parts.push(p);
			}
		}

		if (parts.length === 0) {
			return { target: null, settingsOverride };
		}

		const subcommand = parts[0]?.toLowerCase();

		switch (subcommand) {
			case "uncommitted":
			case "--uncommitted":
			case "diff":
				return { target: { type: "uncommitted" }, settingsOverride };

			case "branch":
			case "--branch": {
				const branch = parts[1];
				if (!branch) return { target: null, settingsOverride };
				return { target: { type: "baseBranch", branch }, settingsOverride };
			}

			case "commit":
			case "--commit": {
				const sha = parts[1];
				if (!sha) return { target: null, settingsOverride };
				const title = parts.slice(2).join(" ") || undefined;
				return { target: { type: "commit", sha, title }, settingsOverride };
			}

			case "custom":
			case "--custom": {
				const instructions = parts.slice(1).join(" ");
				if (!instructions) return { target: null, settingsOverride };
				return { target: { type: "custom", instructions }, settingsOverride };
			}

			case "folder":
			case "--folder": {
				const paths = parseReviewPaths(parts.slice(1).join(" "));
				if (paths.length === 0) return { target: null, settingsOverride };
				return { target: { type: "folder", paths }, settingsOverride };
			}

			case "pr":
			case "--pr": {
				const ref = parts[1];
				if (!ref) return { target: null, settingsOverride };
				return { target: { type: "pr", ref }, settingsOverride };
			}

			default:
				return { target: { type: "custom", instructions: parts.join(" ") }, settingsOverride };
		}
	}

	// 注册 /review 主命令
	pi.registerCommand("review", {
		description: "启动 AI 代码审查 (交互式选择：未提交改动/分支对比/指定Commit/PR/目录/自定义/配置)",
		handler: async (args, ctx) => {
			try {
				if (!ctx.hasUI) {
					ctx.ui.notify("代码审查需要交互式终端环境", "error");
					return;
				}

				if (isSessionLocked(ctx)) {
					ctx.ui.notify("当前已有正在进行的审查。请使用 /review-end 结束，或输入 /review-reset 强制重置。", "warning");
					return;
				}

				const { code } = await safeExec(pi, "git", ["rev-parse", "--git-dir"], 8000);
				if (code === -1) {
					ctx.ui.notify("Git 仓库状态检测超时，请检查磁盘负载或是否有其他进程持有文件锁", "warning");
					return;
				}
				if (code !== 0) {
					ctx.ui.notify("当前目录不是有效的 Git 仓库", "error");
					return;
				}

				let target: ReviewTarget | null = null;
				let fromSelector = false;
				const { target: parsedTarget, settingsOverride } = parseArgs(args);

				if (parsedTarget) {
					if (parsedTarget.type === "pr") {
						target = await handlePrCheckout(ctx, parsedTarget.ref);
						if (!target) {
							ctx.ui.notify("PR 检出失败，返回主菜单。", "warning");
						}
					} else {
						target = parsedTarget;
					}
				}

				if (!target) {
					fromSelector = true;
				}

				while (true) {
					if (!target && fromSelector) {
						target = await showReviewSelector(ctx);
					}

					if (!target) {
						ctx.ui.notify("已取消代码审查", "info");
						return;
					}

					const entries = ctx.sessionManager.getEntries();
					const messageCount = entries.filter((e) => e.type === "message").length;

					let useFreshSession = false;

					if (messageCount > 0) {
						const choice = await ctx.ui.select("选择审查执行环境：", [
							"独立分支审查 (推荐，主会话保持干净)",
							"当前会话直接审查",
						]);

						if (choice === undefined) {
							if (fromSelector) {
								target = null;
								continue;
							}
							ctx.ui.notify("已取消代码审查", "info");
							return;
						}

						useFreshSession = choice.startsWith("独立分支审查");
					}

					await executeReview(ctx, target, useFreshSession, settingsOverride);
					return;
				}
			} catch (err) {
				ctx.ui.notify(`代码审查执行异常: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// 注册 /review-config 配置命令
	pi.registerCommand("review-config", {
		description: "配置代码审查模式 (切换单模型直接审查 / 多 Subagent 并发 2~6 个专家)",
		handler: async (_args, ctx) => {
			try {
				if (!ctx.hasUI) {
					ctx.ui.notify("review-config 需要交互式终端环境", "error");
					return;
				}
				await showConfigDialog(ctx);
			} catch (err) {
				ctx.ui.notify(`审查配置执行异常: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// 极速单兵别名命令：/review-lite
	pi.registerCommand("review-lite", {
		description: "极速代码审查 (直接对当前工作区未提交改动做审查，无需弹窗选择)",
		handler: async (_args, ctx) => {
			try {
				if (!ctx.hasUI) {
					ctx.ui.notify("代码审查需要交互式终端环境", "error");
					return;
				}

				if (isSessionLocked(ctx)) {
					ctx.ui.notify("当前已有正在进行的审查。请使用 /review-end 结束，或输入 /review-reset 强制重置。", "warning");
					return;
				}

				const { code } = await safeExec(pi, "git", ["rev-parse", "--git-dir"], 8000);
				if (code === -1) {
					ctx.ui.notify("Git 仓库状态检测超时，请检查磁盘负载或是否有其他进程持有文件锁", "warning");
					return;
				}
				if (code !== 0) {
					ctx.ui.notify("当前目录不是有效的 Git 仓库", "error");
					return;
				}

				await executeReview(ctx, { type: "uncommitted" }, false, undefined, "lite");
			} catch (err) {
				ctx.ui.notify(`极速代码审查执行异常: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// 全量深度审查命令：/review-full
	pi.registerCommand("review-full", {
		description: "全量深度代码审查 (直接对工作区与分支全部改动展开深度审查，无多余前置步骤与待办清单)",
		handler: async (args, ctx) => {
			try {
				if (!ctx.hasUI) {
					ctx.ui.notify("代码审查需要交互式终端环境", "error");
					return;
				}

				if (isSessionLocked(ctx)) {
					ctx.ui.notify("当前已有正在进行的审查。请使用 /review-end 结束，或输入 /review-reset 强制重置。", "warning");
					return;
				}

				const { code } = await safeExec(pi, "git", ["rev-parse", "--git-dir"], 8000);
				if (code === -1) {
					ctx.ui.notify("Git 仓库状态检测超时，请检查磁盘负载或是否有其他进程持有文件锁", "warning");
					return;
				}
				if (code !== 0) {
					ctx.ui.notify("当前目录不是有效的 Git 仓库", "error");
					return;
				}

				const { target, settingsOverride } = parseArgs(args);
				let finalTarget = target && target.type !== "pr" ? target : null;

				if (!finalTarget) {
					const defaultType = await getSmartDefault();
					if (defaultType === "baseBranch") {
						const defaultBranch = await getDefaultBranch(pi);
						finalTarget = { type: "baseBranch", branch: defaultBranch };
					} else {
						finalTarget = { type: "uncommitted" };
					}
				}

				await executeReview(ctx, finalTarget, false, settingsOverride, "full");
			} catch (err) {
				ctx.ui.notify(`全量代码审查执行异常: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// 审查总结专用提示词
	const REVIEW_SUMMARY_PROMPT = `> 🚨【语言指令】：总结报告必须 100% 使用纯正中文，严禁使用英文！

我们即将结束代码审查并切回开发主对话。
请将本次代码审查分支中发现的所有核心问题、缺陷与建议生成一份结构清晰的中文整改总结。

必须严格按以下格式输出总结（确保原样保留文件路径、行号与缺陷等级）：

## 待办修复清单
1. [需优先解决的 P0/P1 问题]

## 代码审查发现归档

### [P0|P1|P2|P3] 问题标题
- 位置：文件路径:行号
- 说明：缺陷描述与引发场景
- 修复：最小修复建议
`;

	// 注册 /review-end (及向后兼容的 /end-review) 结束审查并返回命令
	const handleReviewEnd = async (_args: string | undefined, ctx: ExtensionCommandContext) => {
		try {
			if (!ctx.hasUI) {
				ctx.ui.notify("review-end 需要交互式终端环境", "error");
				return;
			}

			let originId = reviewOriginId;
			if (!originId) {
				const state = getReviewState(ctx);
				if (state?.active && state.originId) {
					originId = state.originId;
					reviewOriginId = state.originId;
				} else if (state?.active) {
					setReviewWidget(ctx, false);
					pi.appendEntry(REVIEW_STATE_TYPE, { active: false, originId: state.originId });
					ctx.ui.notify("未检测到分支关联信息，已重置审查状态。", "warning");
					return;
				} else {
					ctx.ui.notify("当前不在独立审查分支中 (当前审查是在主会话模式下进行的，无需返回)。", "info");
					return;
				}
			}

			const summaryChoice = await ctx.ui.select("是否将审查结果汇总后返回？", [
				"汇总审查结果并返回主分支 (生成修复待办)",
				"直接返回 (不生成总结)",
			]);

			if (summaryChoice === undefined) {
				ctx.ui.notify("已取消。输入 /review-end 可再次返回。", "info");
				return;
			}

			const wantsSummary = summaryChoice.startsWith("汇总审查结果");

			if (wantsSummary) {
				const result = await ctx.ui.custom<{ cancelled: boolean; error?: string } | null>((tui, theme, _kb, done) => {
					let settled = false;
					const finish = (val: { cancelled: boolean; error?: string } | null) => {
						if (settled) return;
						settled = true;
						done(val);
					};

					const loader = new BorderedLoader(tui, theme, "正在汇总代码审查报告并返回主分支...");
					loader.onAbort = () => finish(null);

					ctx.navigateTree(originId!, {
						summarize: true,
						customInstructions: REVIEW_SUMMARY_PROMPT,
						replaceInstructions: true,
					})
						.then(finish)
						.catch((err) => finish({ cancelled: false, error: err instanceof Error ? err.message : String(err) }));

					return {
						render: (w) => loader.render(w),
						invalidate: () => loader.invalidate(),
						handleInput: (d) => {
							loader.handleInput(d);
							tui.requestRender();
						},
					};
				});

				if (result === null) {
					ctx.ui.notify("已中断等待。后台总结可能仍在进行，完成后会自动返回主会话。", "info");
					return;
				}

				if (result.error) {
					ctx.ui.notify(`AI 总结失败 (${result.error})，正在自动尝试直接返回主分支...`, "warning");
					try {
						const navRes = await ctx.navigateTree(originId!, { summarize: false });
						if (navRes.cancelled) {
							ctx.ui.notify("导航已取消，当前仍保留在审查分支中。", "info");
							return;
						}
						setReviewWidget(ctx, false);
						reviewOriginId = undefined;
						pi.appendEntry(REVIEW_STATE_TYPE, { active: false, originId });
						ctx.ui.notify("已直接返回主会话（未生成整改总结）。", "info");
						return;
					} catch (navErr) {
						ctx.ui.notify(`返回失败: ${navErr instanceof Error ? navErr.message : String(navErr)}。可使用 /review-reset 强制重置状态。`, "error");
						return;
					}
				}

				if (result.cancelled) {
					ctx.ui.notify("导航已取消，当前仍保留在审查分支中。", "info");
					return;
				}

				setReviewWidget(ctx, false);
				reviewOriginId = undefined;
				pi.appendEntry(REVIEW_STATE_TYPE, { active: false, originId });

				if (!ctx.ui.getEditorText().trim()) {
					ctx.ui.setEditorText("根据上述代码审查发现进行修改修复");
				}

				ctx.ui.notify("代码审查已完成！已顺利返回主会话开发分支。", "info");
			} else {
				try {
					const result = await ctx.navigateTree(originId!, { summarize: false });

					if (result.cancelled) {
						ctx.ui.notify("导航已取消，当前仍保留在审查分支中。", "info");
						return;
					}

					setReviewWidget(ctx, false);
					reviewOriginId = undefined;
					pi.appendEntry(REVIEW_STATE_TYPE, { active: false, originId });
					ctx.ui.notify("代码审查已结束，已直接返回主会话。", "info");
				} catch (error) {
					ctx.ui.notify(`返回失败: ${error instanceof Error ? error.message : String(error)}。可使用 /review-reset 强制重置状态。`, "error");
				}
			}
		} catch (err) {
			ctx.ui.notify(`结束代码审查执行异常: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	};

	pi.registerCommand("review-end", {
		description: "完成代码审查并一键返回主会话位置 (自动汇总待办并回填修复指令)",
		handler: handleReviewEnd,
	});

	// 向后兼容保留 /end-review
	pi.registerCommand("end-review", {
		description: "完成代码审查并一键返回主会话位置 (/review-end 别名)",
		handler: handleReviewEnd,
	});

	// 注册 /review-reset 强制重置状态命令
	pi.registerCommand("review-reset", {
		description: "强制重置卡死或残留的代码审查会话状态与界面挂件 (优先尝试返回主会话)",
		handler: async (_args, ctx) => {
			try {
				const targetOriginId = reviewOriginId ?? getReviewState(ctx)?.originId;
				reviewOriginId = undefined;
				setReviewWidget(ctx, false);
				pi.appendEntry(REVIEW_STATE_TYPE, { active: false, originId: targetOriginId });

				if (targetOriginId) {
					try {
						const result = await ctx.navigateTree(targetOriginId, { summarize: false });
						if (!result.cancelled) {
							ctx.ui.notify("已成功强制重置审查状态并返回主会话。", "info");
							return;
						}
					} catch {
						/* 忽略导航错误，降级提示 */
					}
				}
				ctx.ui.notify("已成功强制重置代码审查会话状态。若当前仍停留在审查分支，可使用 /sessions 切换回主会话。", "info");
			} catch (err) {
				ctx.ui.notify(`重置审查状态异常: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// 针对【代码开发会话·修复方】的提示词模板
	const DEV_FIX_PROMPT_TEMPLATE = `> 语言要求：全流程使用纯正中文。
> 提示：无需执行 git commit 或 push，只需修改代码并说明，由用户确认后自行提交。

# 代码审查意见整改与回复

外部审查专家提出了以下代码审查意见：
---
{content}
---

## 核心处理原则：
1. **有道理的就修改，并总结修改了啥**：结合代码上下文逐条仔细核验。确实存在缺陷或隐患的，直接修改代码并保证逻辑自洽；在总结中明确说明修改了哪些文件、函数及具体改了什么。
2. **没有道理的就在总结里解释**：若某些意见属于误报、不符合实际业务场景或既有架构已有防护，请在总结中清晰解释为什么没有道理，无需修改。
3. **输出整改报告**（供复核人员查验）：在最终回复末尾，严格按以下格式总结：

### 🛠️ 整改与回复报告
- **[已修复] [问题标题]**
  - **修改了什么**：说明修改的文件、函数及具体改动内容
- **[无需修改/已说明] [问题标题]**
  - **为何没有道理**：清晰解释为什么该条意见不适用或为什么无需修改

### 📝 整改总结
一句话总结本次代码变动。
`;

	// 针对【审查复核会话·审查方】的提示词模板
	const REVIEWER_RECHECK_PROMPT_TEMPLATE = `> 语言要求：全流程使用纯正中文。
> 提示：当前为只读复核模式，请勿修改代码或执行提交。

# 复核开发者的代码修复与整改说明

开发者提交了针对此前代码审查的整改回复：
---
{content}
---

## 核心复核原则：
1. **不要只听信总结报告，必须实际去看改了啥**：
   - 绝不能因为报告声称“已修复”就盲目相信。必须立即运行 \`git diff\` 亲眼核对实际改动代码，并按需使用 \`read\` 查看改动前后的完整方法与类上下文。
2. **逐项实事求是核验**：
   - 对照开发者声称“已修复”的项，检查实际 diff 是否真正彻底解决了缺陷，且未引入新的逻辑隐患或并发风险。
   - 对照开发者声称“无需修改”的解释，客观评估其理由是否合乎技术事实。
3. **给出复核结论**：
   - 若实测代码已全部妥善修复且质量良好：输出 **## ✅【审核通过，可以提交代码】**
   - 若实际代码未修改、改动不彻底或引入新问题：输出 **## ❌【仍有阻塞问题需继续修改】** 并指出具体代码缺陷与修改要求。
`;

	function detectReviewSyncRole(
		ctx: ExtensionContext,
		content: string,
		flag?: "fix" | "check",
	): "fix" | "check" {
		if (flag) return flag;

		// 1. 若当前处于活跃的独立审查分支中 (active: true)，则判定为只读复核方
		const state = getReviewState(ctx);
		if (state?.active) {
			return "check";
		}

		// 2. 文本特征识别：
		// 开发者修复整改汇报通常包含 "[已修复]"、"整改与回复"、"整改总结"、"修改说明"
		// 审查发现清单通常包含 "[P0]"、"[P1]"、"审查发现"、"缺陷说明"、"综合裁决"
		const hasFixMarkers = /\[已修复\]|整改与回复|整改总结|修改说明|为何没有道理/i.test(content);
		const hasReviewMarkers = /\[P[0-3]\]|审查发现|缺陷说明|综合裁决/i.test(content);

		if (hasFixMarkers && !hasReviewMarkers) {
			return "check";
		}

		// 默认作为开发修复方：有理改代码，没理写说明
		return "fix";
	}

	async function handleReviewSync(rawArgs: string | undefined, ctx: ExtensionCommandContext) {
		try {
			if (!ctx.hasUI) {
				ctx.ui.notify("review-sync 需要交互式终端环境", "error");
				return;
			}

			let text = rawArgs?.trim() || "";
			let forcedRole: "fix" | "check" | undefined = undefined;

			if (text.startsWith("--fix ")) {
				forcedRole = "fix";
				text = text.slice(6).trim();
			} else if (text.startsWith("--check ") || text.startsWith("--review ")) {
				forcedRole = "check";
				text = text.replace(/^--(?:check|review)\s+/, "").trim();
			}

			if (!text) {
				const input = await ctx.ui.editor(
					"请粘贴 Review 审查发现清单（发给开发会话修复）或 修复整改说明（发给审查会话复核）：",
					"",
				);
				if (!input?.trim()) {
					ctx.ui.notify("已取消操作", "info");
					return;
				}
				text = input.trim();
			}

			const role = detectReviewSyncRole(ctx, text, forcedRole);

			if (role === "fix") {
				ctx.ui.notify("🤖 自动识别为【代码开发会话】：正在逐项核验并执行代码修复...", "info");
				const prompt = DEV_FIX_PROMPT_TEMPLATE.replace("{content}", text);
				pi.sendUserMessage(prompt);
			} else {
				ctx.ui.notify("🔍 自动识别为【审查复核会话】：正在对照改动进行只读复核 (严禁改动代码)...", "info");
				const prompt = REVIEWER_RECHECK_PROMPT_TEMPLATE.replace("{content}", text);
				pi.sendUserMessage(prompt);
			}
		} catch (err) {
			ctx.ui.notify(`审查同步执行异常: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	}

	// 注册双会话审查接力闭环命令：/review-sync
	pi.registerCommand("review-sync", {
		description: "双会话审查接力闭环 (自动识别：开发会话自动改代码并总结，审查会话只读复核直到可提交)",
		handler: handleReviewSync,
	});
}