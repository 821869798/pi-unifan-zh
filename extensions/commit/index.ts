import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	commitWithMsg,
	getStagedFiles,
	getStagedDiff,
	getUnpushedCommits,
	getUnstagedDiff,
	isGitRepo,
	pushCurrentBranch,
	stageAll,
} from "./src/git.js";
import { COMMIT_SYSTEM_PROMPT } from "./src/prompt.js";

interface ParsedCommitArgs {
	stageAll: boolean;
	hint?: string;
}

function parseArgs(raw: string): ParsedCommitArgs {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	let shouldStageAll = false;
	const hintParts: string[] = [];

	for (const t of tokens) {
		if (t === "-a" || t === "--all") {
			shouldStageAll = true;
		} else if (t !== "-y" && t !== "--yes") {
			hintParts.push(t);
		}
	}

	return {
		stageAll: shouldStageAll,
		hint: hintParts.join(" ").trim() || undefined,
	};
}

export async function generateCommitMessage(
	ctx: ExtensionCommandContext,
	diff: string,
	changedFiles: string[],
	userHint?: string,
	thinkingLevel = ctx.thinkingLevel,
): Promise<string> {
	const truncatedDiff = diff.length > 30000 ? diff.slice(0, 30000) + "\n\n... (diff已截断)" : diff;
	const userPrompt = [
		`## 修改的文件清单 (${changedFiles.length} 个文件):`,
		changedFiles.map((f) => `- ${f}`).join("\n"),
		"",
		userHint ? `## 用户额外补充说明:\n${userHint}\n` : "",
		"## Git Diff 变动详情:",
		"```diff",
		truncatedDiff,
		"```",
	]
		.filter(Boolean)
		.join("\n");

	if (!ctx.model) throw new Error("当前未选择模型，请先使用 /model 选择模型。");
	if (typeof ctx.modelRegistry?.getProvider !== "function" || typeof ctx.modelRegistry?.getProviderAuth !== "function")
		throw new Error("当前 Pi 不支持统一模型调用接口，请更新 Pi 后重试。");
	const modelLabel = `${ctx.model.provider}/${ctx.model.id}`;
	const provider = ctx.modelRegistry.getProvider(ctx.model.provider);
	if (!provider) throw new Error(`模型 ${modelLabel} 的提供方不可用，请重新选择模型。`);
	const resolved = await ctx.modelRegistry.getProviderAuth(ctx.model.provider);
	if (!resolved) throw new Error(`模型 ${modelLabel} 的认证未配置，请先完成登录或配置认证。`);

	// 宿主解析认证、代理地址和环境；统一接口按模型能力转换会话思考档位，避免底层调用默认发送 none。
	const model = resolved.auth.baseUrl ? { ...ctx.model, baseUrl: resolved.auth.baseUrl } : ctx.model;
	const response = await provider.streamSimple(model, {
		systemPrompt: COMMIT_SYSTEM_PROMPT,
		messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
	}, {
		maxTokens: 4096,
		signal: ctx.signal,
		reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
		apiKey: resolved.auth.apiKey,
		headers: resolved.auth.headers,
		env: resolved.env,
	}).result();
	if (response.stopReason !== "stop")
		throw new Error(`模型 ${modelLabel} 未正常完成生成（${response.stopReason}）：${response.errorMessage || "请检查模型状态后重试。"}`);

	const text = response.content.map((c) => c.type === "text" ? c.text : "").join("").trim()
		.replace(/^```[a-zA-Z]*\r?\n?/, "").replace(/\r?\n?```$/, "").trim();
	if (!text) throw new Error("模型返回了空的提交信息。");
	if (!/^(feat|fix|perf|refactor|ci|build|chore|docs|test|style|revert)(\([^()\r\n]+\))?: [^\r\n]+$/.test(text.split(/\r?\n/)[0]))
		throw new Error("模型返回的提交标题不符合约定格式，请重试或补充修改说明。");
	if (text.includes("更新代码与相关配置"))
		throw new Error("模型返回了无具体业务含义的通用提交信息，请补充修改说明后重试。");
	return text;
}

export default function (pi: ExtensionAPI) {
	const handleCommitCommand = async (args: string, ctx: ExtensionCommandContext, andPush = false) => {
		const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(msg, level);
			else console.log(`pi-commit: ${msg}`);
		};

		if (!(await isGitRepo(ctx.cwd))) {
			notify("当前目录不是 Git 仓库，无法执行 commit。", "error");
			return;
		}

		const parsed = parseArgs(args);
		let stagedDiff = await getStagedDiff(ctx.cwd);
		const unstagedDiff = await getUnstagedDiff(ctx.cwd);


		if (!stagedDiff && !unstagedDiff) {
			if (andPush) {
				const unpushed = await getUnpushedCommits(ctx.cwd);
				if (unpushed.length > 0) {
					notify(`当前工作区干净，但检测到有 ${unpushed.length} 个未推送提交，正在推送到远端...`, "info");
					const pushRes = await pushCurrentBranch(ctx.cwd, (msg) => notify(msg, "info"));
					if (pushRes.ok) {
						const successMsg = pushRes.autoRebased
							? `🚀 已自动完成变基 (pull --rebase)，并成功将 ${unpushed.length} 个本地提交推送至远端！`
							: `🚀 成功将本地未推送的 ${unpushed.length} 个提交推送至远端！`;
						notify(successMsg, "info");
						pi.sendMessage({
							customType: "pi-commit-result",
							content: `### 🚀 远端推送完成\n\n当前工作区无未提交的修改，已成功将本地 **${unpushed.length} 个历史提交** 推送至远端分支：\n\n\`\`\`text\n${unpushed.join("\n")}\n\`\`\`\n\n${successMsg}`,
							display: true,
						});
					} else {
						if (pushRes.hasConflict) {
							notify("⚠️ 远端变基冲突：请对比修改与上下文解决冲突，严禁直接使用 ours/theirs。", "warning");
						} else {
							notify(`⚠️ 推送失败: ${pushRes.output}`, "error");
						}
						pi.sendMessage({
							customType: "pi-commit-result",
							content: `### ⚠️ 推送到远端未完成\n\n${pushRes.output}`,
							display: true,
						});
					}
					return;
				}
			}
			notify("当前工作区干净，且所有本地提交均已同步至远端，无需提交和推送。", "info");
			return;
		}

		if (!stagedDiff && unstagedDiff) {
			notify("未发现暂存区文件，已自动暂存全部修改 (git add -A)...", "info");
			await stageAll(ctx.cwd);
			stagedDiff = await getStagedDiff(ctx.cwd);
		} else if (parsed.stageAll) {
			await stageAll(ctx.cwd);
			stagedDiff = await getStagedDiff(ctx.cwd);
		}

		notify("正在深度分析代码改动并生成中文 Commit Message...", "info");
		let commitMessage: string;
		try {
			if (!stagedDiff.trim()) throw new Error("暂存区没有可用于生成提交信息的差异。");
			const changedFiles = await getStagedFiles(ctx.cwd);
			commitMessage = await generateCommitMessage(
				ctx, stagedDiff, changedFiles, parsed.hint, ctx.thinkingLevel ?? pi.getThinkingLevel(),
			);
		} catch (error) {
			// 生成失败必须停止，禁止用固定文案继续提交或推送。
			const reason = error instanceof Error ? error.message : String(error);
			notify(`提交信息生成失败，未执行提交或推送：${reason}`, "error");
			pi.sendMessage({ customType: "pi-commit-error", content: `提交信息生成失败，未执行提交或推送。\n\n${reason}\n\n当前暂存内容保留，可修复模型配置后重新执行。`, display: true });
			return;
		}

		const commitRes = await commitWithMsg(ctx.cwd, commitMessage);
		if (!commitRes.ok) {
			notify(`Git 提交失败: ${commitRes.output}`, "error");
			return;
		}

		const firstLine = commitMessage.split("\n")[0];
		notify(`✅ 成功提交: ${firstLine}`, "info");

		let pushText = "";
		if (andPush) {
			notify("正在推送到远端仓库 (git push)...", "info");
			const pushRes = await pushCurrentBranch(ctx.cwd, (msg) => notify(msg, "info"));
			if (pushRes.ok) {
				const successMsg = pushRes.autoRebased
					? "🚀 远端有新提交，已自动完成变基 (pull --rebase) 并成功推送！"
					: "🚀 成功推送到远端仓库！";
				notify(successMsg, "info");
				pushText = `\n\n${successMsg}`;
			} else {
				if (pushRes.hasConflict) {
					notify("⚠️ 远端变基冲突：请对比修改与上下文解决冲突，严禁直接使用 ours/theirs。", "warning");
				} else {
					notify(`⚠️ 推送失败: ${pushRes.output}`, "error");
				}
				pushText = `\n\n${pushRes.output}`;
			}
		}

		pi.sendMessage({
			customType: "pi-commit-result",
			content: `### 📦 Git 提交完成\n\n\`\`\`text\n${commitMessage}\n\`\`\`${pushText}`,
			display: true,
		});
	};

	pi.registerCommand("commit", {
		description: "智能 Git 提交助手：自动分析 diff 生成标准中文 Commit 并直接提交 (-a 自动暂存全部修改)",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				{ value: "-a", label: "-a / --all", description: "自动暂存全部修改 (git add -A)" },
			];
			const trimmed = prefix.trimStart();
			if (!trimmed) return options;
			return options.filter((o) => o.value.startsWith(trimmed));
		},
		handler: async (args, ctx) => {
			await handleCommitCommand(args, ctx, false);
		},
	});

	pi.registerCommand("commit-push", {
		description: "智能 Git 提交并推流：生成标准中文 Commit 后自动提交并执行 git push (支持自动变基与未推送提交自动推流)",
		handler: async (args, ctx) => {
			await handleCommitCommand(args, ctx, true);
		},
	});
}