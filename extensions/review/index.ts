/**
 * Pi 交互式 AI 代码审查扩展 (中文增强版)
 *
 * 参考并融合了 Codex 与 pi-agent-extensions (Armin Ronacher @mitsuhiko) 的经典架构：
 * 采用原生会话与会话分支隔离树技术，彻底摒弃脆弱的多子代理并发通信链路。
 * 零网络断流、零子进程超时、支持任意大模型（GPT/Claude/DeepSeek/免费模型）。
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
 * - 审查过程中常驻黄色横幅提醒，完成后敲 /end-review
 * - /end-review 自动将审查发现 (P0~P3) 结构化汇总并一键跳回原会话位置，自动填入修复指令
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import path from "node:path";
import { promises as fs } from "node:fs";

// 跟踪审查会话来源分支节点（保证单次仅一个活跃审查会话）
let reviewOriginId: string | undefined = undefined;

const REVIEW_STATE_TYPE = "review-session";

type ReviewSessionState = {
	active: boolean;
	originId?: string;
};

function setReviewWidget(ctx: ExtensionContext, active: boolean) {
	if (!ctx.hasUI) return;
	if (!active) {
		ctx.ui.setWidget("review", undefined);
		return;
	}

	ctx.ui.setWidget("review", (_tui, theme) => {
		const text = new Text(theme.fg("warning", "🔍 代码审查分支进行中，审查完毕后输入 /end-review 返回主对话"), 0, 0);
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
const UNCOMMITTED_PROMPT =
	"请审查当前代码的所有改动（包含暂存区、未暂存区以及新增文件）。请直接运行 `git diff`、`git status` 及必要的文件读取工具深入审查，并给出按优先级排序的具体审查发现。所有输出必须使用纯正中文。";

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
	"请审查当前分支相对于基准分支 '{baseBranch}' 的改动代码。两者的合并基准 commit 为 {mergeBaseSha}。请直接运行 `git diff {mergeBaseSha}` 检查本次改动并给出按优先级排序的具体审查发现。所有输出必须使用纯正中文。";

const BASE_BRANCH_PROMPT_FALLBACK =
	"请审查当前分支相对于基准分支 '{branch}' 的改动代码。首先使用 `git merge-base HEAD \"$(git rev-parse --abbrev-ref \"{branch}@{upstream}\")\"` 找到合并基准，再通过 `git diff` 检查改动并给出具体审查发现。所有输出必须使用纯正中文。";

const COMMIT_PROMPT_WITH_TITLE =
	'请审查提交 commit {sha} ("{title}") 引入的代码改动。直接运行 `git show {sha}` 检查差异并给出按优先级排序的具体审查发现。所有输出必须使用纯正中文。';

const COMMIT_PROMPT =
	"请审查提交 commit {sha} 引入的代码改动。直接运行 `git show {sha}` 检查差异并给出按优先级排序的具体审查发现。所有输出必须使用纯正中文。";

const PULL_REQUEST_PROMPT =
	'请审查 Pull Request #{prNumber} ("{title}") 相对于基准分支 \'{baseBranch}\' 的改动代码。两者的合并基准 commit 为 {mergeBaseSha}。请直接运行 `git diff {mergeBaseSha}` 检查改动并给出按优先级排序的具体审查发现。所有输出必须使用纯正中文。';

const PULL_REQUEST_PROMPT_FALLBACK =
	'请审查 Pull Request #{prNumber} ("{title}") 相对于基准分支 \'{baseBranch}\' 的改动代码。首先寻找当前分支与 {baseBranch} 的合并基准 (例如 `git merge-base HEAD {baseBranch}`)，再通过 `git diff` 检查改动并给出具体审查发现。所有输出必须使用纯正中文。';

const FOLDER_REVIEW_PROMPT =
	"请对以下目录/文件路径的代码进行快照审查：{paths}。注意这是全量快照审查（非 diff 对比）。请直接读取这些文件并给出按优先级排序的具体审查发现。所有输出必须使用纯正中文。";

// 权威的中文代码审查准则 (基于 Codex 准则精炼与本土化)
const REVIEW_RUBRIC = `# 核心代码审查准则（资深工程师视角）

你正在作为一名资深技术专家对另一位工程师提交的代码改动进行严格的代码审查。你的目标是帮作者把关并拦截真实风险，给出清晰、可落地、带事实证据的中文审查意见。

## 重点排查范围（排查什么）
1. **代码正确性与边界处理**：逻辑缺陷、空指针/未定义引用、边界越界、生命周期异常、未捕获的运行时异常。
2. **并发与状态安全**：竞态条件、死锁隐患、异步缺少等待、未处理的取消或中断、脏状态残留。
3. **性能与内存开销**：高频主循环内的大量内存分配 (GC 压力)、不必要的深拷贝、高复杂度算法、资源句柄或网络连接未释放。
4. **代码健壮性与外部合规**：
   - 严禁信任外部用户输入（必须检查未参数化的 SQL、路径穿越、未校验的 URL 重定向、危险的反序列化等）。
   - 报错与异常必须检查稳定的错误码或类型，严禁用脆弱的错误文本字符串做业务分支判断。
5. **本次改动引入的缺陷**：只审查本次改动实际引入的问题，严禁把改动前既有的历史代码或未改动代码归咎为缺陷。

## 严格过滤误报（不排查什么）
- ❌ 严禁提出吹毛求疵、纯属个人审美的废话风格建议（若无明确项目规范强制要求）。
- ❌ 严禁提出 Linter、类型检查器、编译构建会自动捕获的浅层格式建议。
- ❌ 严禁基于未证实的纯主观假设进行无端猜测，每一条问题必须有明确的代码事实证据。

## 缺陷严重等级标记
每一条审查发现必须在标题中清晰标注严重等级：
- **[P0 - 致命阻塞]** 导致系统崩溃、死锁、数据损坏、关键功能完全不可用或高危漏洞，必须立即修复，阻断合并。
- **[P1 - 紧急待修]** 明确的逻辑缺陷、高概率边界异常、严重性能退化或破坏公共接口契约，应在本次合并前修复。
- **[P2 - 普通建议]** 局部的健壮性隐患、轻度可读性或次要设计问题，建议在后续优化。
- **[P3 - 细节优化]** 极轻微的细节优化建议，不影响业务。

## 输出格式（所有内容必须使用纯正中文）
请按以下规范输出审查报告：

### 审查发现清单
每个问题按以下格式列出（若完全无缺陷，请明确输出：\`未发现存活的代码缺陷，代码质量良好，建议合并。\`）：
- **[P0|P1|P2|P3] 简短标题**：\`文件路径:行号\`
  - **缺陷说明**：简明扼要说明该问题会导致什么后果以及在何种场景下被触发。
  - **代码证据**：引用 1~3 行具体代码或调用链路。
  - **修改建议**：给出最小化的修复思路或直接附带精准的代码替换块（可使用 \`\`\`suggestion 代码块）。

### 综合裁决
- **最终结论**：\`通过 (Approved)\` 或 \`需要修改 (Request Changes - 存在 P0/P1 阻塞问题)\`
- **总结说明**：一句话中文总评。`;

/**
 * 尝试加载项目本地的专属审查准则文件 (REVIEW_GUIDELINES.md 或 AGENTS.md / CLAUDE.md)
 */
async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
	let currentDir = path.resolve(cwd);

	while (true) {
		const piDir = path.join(currentDir, ".pi");
		const candidates = [
			path.join(currentDir, "REVIEW_GUIDELINES.md"),
			path.join(currentDir, "AGENTS.md"),
			path.join(currentDir, "CLAUDE.md"),
		];

		const piStats = await fs.stat(piDir).catch(() => null);
		if (piStats?.isDirectory()) {
			for (const guidelinePath of candidates) {
				const stat = await fs.stat(guidelinePath).catch(() => null);
				if (stat?.isFile()) {
					try {
						const content = await fs.readFile(guidelinePath, "utf8");
						const trimmed = content.trim();
						if (trimmed) return trimmed.slice(0, 3000);
					} catch {
						/* ignore */
					}
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
 * 获取 HEAD 与指定分支的 merge base
 */
async function getMergeBase(pi: ExtensionAPI, branch: string): Promise<string | null> {
	try {
		const { stdout: upstream, code: upstreamCode } = await pi.exec("git", [
			"rev-parse",
			"--abbrev-ref",
			`${branch}@{upstream}`,
		]);

		if (upstreamCode === 0 && upstream.trim()) {
			const { stdout: mergeBase, code } = await pi.exec("git", ["merge-base", "HEAD", upstream.trim()]);
			if (code === 0 && mergeBase.trim()) return mergeBase.trim();
		}

		const { stdout: mergeBase, code } = await pi.exec("git", ["merge-base", "HEAD", branch]);
		if (code === 0 && mergeBase.trim()) return mergeBase.trim();
		return null;
	} catch {
		return null;
	}
}

async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec("git", ["branch", "--format=%(refname:short)"]);
	if (code !== 0) return [];
	return stdout
		.trim()
		.split("\n")
		.map((b) => b.trim())
		.filter(Boolean);
}

async function getRecentCommits(pi: ExtensionAPI, limit = 20): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await pi.exec("git", ["log", "--oneline", "-n", `${limit}`]);
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
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
	return code === 0 && stdout.trim().length > 0;
}

async function hasPendingChanges(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
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
	const { stdout, code } = await pi.exec("gh", [
		"pr",
		"view",
		String(prNumber),
		"--json",
		"baseRefName,title,headRefName",
	]);
	if (code !== 0) return null;

	try {
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
	const { stdout, stderr, code } = await pi.exec("gh", ["pr", "checkout", String(prNumber)]);
	if (code !== 0) {
		return { success: false, error: stderr || stdout || "检出 PR 分支失败" };
	}
	return { success: true };
}

async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
	if (code === 0 && stdout.trim()) return stdout.trim();
	return null;
}

async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
	const { stdout, code } = await pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
	if (code === 0 && stdout.trim()) {
		return stdout.trim().replace("origin/", "");
	}
	const branches = await getLocalBranches(pi);
	if (branches.includes("main")) return "main";
	if (branches.includes("master")) return "master";
	return "main";
}

async function buildReviewPrompt(pi: ExtensionAPI, target: ReviewTarget): Promise<string> {
	switch (target.type) {
		case "uncommitted":
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
] as const;

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
		const items: SelectItem[] = REVIEW_PRESETS.slice()
			.sort((a, b) => {
				if (a.value === smartDefault) return -1;
				if (b.value === smartDefault) return 1;
				return 0;
			})
			.map((preset) => ({
				value: preset.value,
				label: preset.label,
				description: preset.description,
			}));

		while (true) {
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
				container.addChild(new Text(theme.fg("accent", theme.bold("请选择代码审查模式"))));

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

			selectList.searchable = true;
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

			selectList.searchable = true;
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

	async function executeReview(ctx: ExtensionCommandContext, target: ReviewTarget, useFreshSession: boolean): Promise<void> {
		if (reviewOriginId) {
			ctx.ui.notify("当前已有正在进行的审查会话。请先使用 /end-review 结束。", "warning");
			return;
		}

		if (useFreshSession) {
			const originId = ctx.sessionManager.getLeafId() ?? undefined;
			if (!originId) {
				ctx.ui.notify("无法获取当前会话位置，请在有消息的会话中重试。", "error");
				return;
			}
			reviewOriginId = originId;
			const lockedOriginId = originId;

			const entries = ctx.sessionManager.getEntries();
			const firstUserMessage = entries.find((e) => e.type === "message" && e.message.role === "user");

			if (!firstUserMessage) {
				ctx.ui.notify("当前会话中未找到任何用户消息", "error");
				reviewOriginId = undefined;
				return;
			}

			try {
				const result = await ctx.navigateTree(firstUserMessage.id, { summarize: false, label: "代码审查" });
				if (result.cancelled) {
					reviewOriginId = undefined;
					return;
				}
			} catch (error) {
				reviewOriginId = undefined;
				ctx.ui.notify(`启动审查分支失败: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			reviewOriginId = lockedOriginId;
			ctx.ui.setEditorText("");
			setReviewWidget(ctx, true);
			pi.appendEntry(REVIEW_STATE_TYPE, { active: true, originId: lockedOriginId });
		}

		const prompt = await buildReviewPrompt(pi, target);
		const hint = getUserFacingHint(target);
		const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);

		let fullPrompt = `${REVIEW_RUBRIC}\n\n---\n\n## 本次审查目标与任务指示\n\n${prompt}`;

		if (projectGuidelines) {
			fullPrompt += `\n\n## 本项目附加规范指南\n\n${projectGuidelines}`;
		}

		const modeHint = useFreshSession ? " (独立审查分支)" : "";
		ctx.ui.notify(`正在启动代码审查: ${hint}${modeHint}`, "info");

		pi.sendUserMessage(fullPrompt);
	}

	function parseArgs(args: string | undefined): ReviewTarget | { type: "pr"; ref: string } | null {
		if (!args?.trim()) return null;

		const parts = args.trim().split(/\s+/);
		const subcommand = parts[0]?.toLowerCase();

		switch (subcommand) {
			case "uncommitted":
			case "--uncommitted":
			case "diff":
				return { type: "uncommitted" };

			case "branch":
			case "--branch": {
				const branch = parts[1];
				if (!branch) return null;
				return { type: "baseBranch", branch };
			}

			case "commit":
			case "--commit": {
				const sha = parts[1];
				if (!sha) return null;
				const title = parts.slice(2).join(" ") || undefined;
				return { type: "commit", sha, title };
			}

			case "custom":
			case "--custom": {
				const instructions = parts.slice(1).join(" ");
				if (!instructions) return null;
				return { type: "custom", instructions };
			}

			case "folder":
			case "--folder": {
				const paths = parseReviewPaths(parts.slice(1).join(" "));
				if (paths.length === 0) return null;
				return { type: "folder", paths };
			}

			case "pr":
			case "--pr": {
				const ref = parts[1];
				if (!ref) return null;
				return { type: "pr", ref };
			}

			default:
				return { type: "custom", instructions: args.trim() };
		}
	}

	// 注册 /review 主命令
	pi.registerCommand("review", {
		description: "启动 AI 代码审查 (交互式选择：未提交改动/分支对比/指定Commit/PR/目录/自定义)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("代码审查需要交互式终端环境", "error");
				return;
			}

			if (reviewOriginId) {
				ctx.ui.notify("当前已有正在进行的审查。请先输入 /end-review 完成审查并返回。", "warning");
				return;
			}

			const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
			if (code !== 0) {
				ctx.ui.notify("当前目录不是有效的 Git 仓库", "error");
				return;
			}

			let target: ReviewTarget | null = null;
			let fromSelector = false;
			const parsed = parseArgs(args);

			if (parsed) {
				if (parsed.type === "pr") {
					target = await handlePrCheckout(ctx, parsed.ref);
					if (!target) {
						ctx.ui.notify("PR 检出失败，返回主菜单。", "warning");
					}
				} else {
					target = parsed;
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

				await executeReview(ctx, target, useFreshSession);
				return;
			}
		},
	});

	// 极速单兵别名命令：/review-lite
	pi.registerCommand("review-lite", {
		description: "极速代码审查 (直接对当前工作区未提交改动做深度审查，无需弹窗选择)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("代码审查需要交互式终端环境", "error");
				return;
			}

			if (reviewOriginId) {
				ctx.ui.notify("当前已有正在进行的审查。请先输入 /end-review 完成审查并返回。", "warning");
				return;
			}

			const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
			if (code !== 0) {
				ctx.ui.notify("当前目录不是有效的 Git 仓库", "error");
				return;
			}

			await executeReview(ctx, { type: "uncommitted" }, false);
		},
	});

	// 审查总结专用提示词
	const REVIEW_SUMMARY_PROMPT = `我们即将结束代码审查并切回开发主对话。
请将本次代码审查分支中发现的所有核心问题、缺陷与建议生成一份结构清晰的中文整改总结。

必须严格按以下格式输出总结（确保原样保留文件路径、行号与缺陷等级）：

## 待办修复清单 (Next Steps)
1. [需优先解决的 P0/P1 问题]

## 代码审查发现归档 (Code Review Findings)

### [P0|P1|P2|P3] 问题标题
- 位置：path/to/file.ext:行号
- 说明：缺陷描述与引发场景
- 修复：最小修复建议
`;

	// 注册 /end-review 结束审查并返回命令
	pi.registerCommand("end-review", {
		description: "完成代码审查并一键返回主会话位置 (自动汇总待办并回填修复指令)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("end-review 需要交互式终端环境", "error");
				return;
			}

			if (!reviewOriginId) {
				const state = getReviewState(ctx);
				if (state?.active && state.originId) {
					reviewOriginId = state.originId;
				} else if (state?.active) {
					setReviewWidget(ctx, false);
					pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
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
				ctx.ui.notify("已取消。输入 /end-review 可再次返回。", "info");
				return;
			}

			const wantsSummary = summaryChoice.startsWith("汇总审查结果");
			const originId = reviewOriginId;

			if (wantsSummary) {
				const result = await ctx.ui.custom<{ cancelled: boolean; error?: string } | null>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, "正在汇总代码审查报告并返回主分支...");
					loader.onAbort = () => done(null);

					ctx.navigateTree(originId!, {
						summarize: true,
						customInstructions: REVIEW_SUMMARY_PROMPT,
						replaceInstructions: true,
					})
						.then(done)
						.catch((err) => done({ cancelled: false, error: err instanceof Error ? err.message : String(err) }));

					return loader;
				});

				if (result === null) {
					ctx.ui.notify("已取消返回操作。", "info");
					return;
				}

				if (result.error) {
					ctx.ui.notify(`返回主分支失败: ${result.error}`, "error");
					return;
				}

				setReviewWidget(ctx, false);
				reviewOriginId = undefined;
				pi.appendEntry(REVIEW_STATE_TYPE, { active: false });

				if (result.cancelled) {
					ctx.ui.notify("导航已取消", "info");
					return;
				}

				if (!ctx.ui.getEditorText().trim()) {
					ctx.ui.setEditorText("根据上述代码审查发现进行修改修复");
				}

				ctx.ui.notify("代码审查已完成！已顺利返回主会话开发分支。", "info");
			} else {
				try {
					const result = await ctx.navigateTree(originId!, { summarize: false });

					if (result.cancelled) {
						ctx.ui.notify("导航已取消", "info");
						return;
					}

					setReviewWidget(ctx, false);
					reviewOriginId = undefined;
					pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
					ctx.ui.notify("代码审查已结束，已直接返回主会话。", "info");
				} catch (error) {
					ctx.ui.notify(`返回失败: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
		},
	});
}