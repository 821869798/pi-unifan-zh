import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	commitWithMsg,
	getChangedFiles,
	getStagedDiff,
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

async function generateCommitMessage(
	ctx: ExtensionCommandContext,
	diff: string,
	changedFiles: string[],
	userHint?: string,
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

	if (ctx.model && ctx.modelRegistry) {
		try {
			const provider = ctx.modelRegistry.getProvider(ctx.model.provider);
			if (provider) {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
				const response = await provider
					.streamSimple(
						ctx.model,
						{
							systemPrompt: COMMIT_SYSTEM_PROMPT,
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: userPrompt }],
									timestamp: Date.now(),
								},
							],
						},
						{ apiKey: auth?.apiKey, headers: auth?.headers, maxTokens: 800 },
					)
					.result();

				const text = response.content
					?.map((c) => (c.type === "text" ? c.text : ""))
					.join("")
					.trim();

				if (text) {
					return text.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
				}
			}
		} catch (err) {
			console.error("pi-commit streamSimple error:", err);
		}
	}

	// 智能保底推断
	const firstFile = changedFiles[0] ?? "core";
	const scope = firstFile.split(/[/\\]/)[0] || "core";
	return `chore(${scope}): 更新代码与相关配置\n\n- 更新了 ${changedFiles.length} 个文件`;
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
		const changedFiles = await getChangedFiles(ctx.cwd);

		if (!stagedDiff && !unstagedDiff) {
			notify("当前工作区没有任何修改，无需提交。", "info");
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
		const commitMessage = await generateCommitMessage(ctx, stagedDiff || unstagedDiff, changedFiles, parsed.hint);

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
				notify(`⚠️ 推送失败: ${pushRes.output}`, "error");
				pushText = `\n\n⚠️ **推送到远端失败**:\n${pushRes.output}`;
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
		description: "智能 Git 提交并推流：生成标准中文 Commit 后自动提交并执行 git push (支持自动变基重试)",
		handler: async (args, ctx) => {
			await handleCommitCommand(args, ctx, true);
		},
	});
}