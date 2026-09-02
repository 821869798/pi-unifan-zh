import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; ok: boolean }> {
	try {
		const res = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
		return { stdout: res.stdout, stderr: res.stderr, ok: true };
	} catch (err: any) {
		return {
			stdout: err?.stdout ?? "",
			stderr: err?.stderr ?? err?.message ?? String(err),
			ok: false,
		};
	}
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	const res = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	return res.ok && res.stdout.trim() === "true";
}

export async function getGitStatus(cwd: string): Promise<string> {
	const res = await runGit(cwd, ["status", "--porcelain"]);
	return res.ok ? res.stdout.trim() : "";
}

export async function getStagedDiff(cwd: string): Promise<string> {
	const res = await runGit(cwd, ["diff", "--cached"]);
	return res.ok ? res.stdout : "";
}

export async function getUnstagedDiff(cwd: string): Promise<string> {
	const res = await runGit(cwd, ["diff"]);
	return res.ok ? res.stdout : "";
}

export async function getChangedFiles(cwd: string): Promise<string[]> {
	const res = await runGit(cwd, ["status", "--porcelain"]);
	if (!res.ok || !res.stdout.trim()) return [];
	return res.stdout
		.split("\n")
		.map((line) => line.trim().slice(3).trim())
		.filter(Boolean);
}

export async function getUnpushedCommits(cwd: string): Promise<string[]> {
	const res = await runGit(cwd, ["log", "@{u}..HEAD", "--oneline"]);
	if (res.ok && res.stdout.trim()) {
		return res.stdout.trim().split("\n").filter(Boolean);
	}
	const statusRes = await runGit(cwd, ["status", "--porcelain=v1", "-b"]);
	if (statusRes.ok) {
		const match = statusRes.stdout.match(/\[ahead\s+(\d+)\]/);
		if (match && match[1]) {
			const count = parseInt(match[1], 10);
			if (count > 0) {
				const logRes = await runGit(cwd, ["log", "-n", String(count), "--oneline"]);
				if (logRes.ok && logRes.stdout.trim()) {
					return logRes.stdout.trim().split("\n").filter(Boolean);
				}
			}
		}
	}
	return [];
}

export async function stageAll(cwd: string): Promise<boolean> {
	const res = await runGit(cwd, ["add", "-A"]);
	return res.ok;
}

export async function commitWithMsg(cwd: string, message: string): Promise<{ ok: boolean; output: string }> {
	const res = await runGit(cwd, ["commit", "-m", message]);
	return { ok: res.ok, output: res.ok ? res.stdout : res.stderr };
}

export async function pushCurrentBranch(
	cwd: string,
	onLog?: (msg: string) => void,
): Promise<{ ok: boolean; output: string; autoRebased?: boolean; hasConflict?: boolean; conflictFiles?: string[] }> {
	let initialPush = await runGit(cwd, ["push"]);
	if (initialPush.ok) {
		return { ok: true, output: initialPush.stdout || "推送成功" };
	}

	let pushError = `${initialPush.stderr} ${initialPush.stdout}`.toLowerCase();

	if (pushError.includes("no upstream branch") || pushError.includes("set-upstream")) {
		if (onLog) onLog("未关联远端分支，正在自动关联并推送 (git push -u origin HEAD)...");
		const setUpstream = await runGit(cwd, ["push", "-u", "origin", "HEAD"]);
		if (setUpstream.ok) {
			return { ok: true, output: setUpstream.stdout || "推送成功" };
		}
		pushError = `${setUpstream.stderr} ${setUpstream.stdout}`.toLowerCase();
	}

	const needsPull =
		pushError.includes("fetch first") ||
		pushError.includes("non-fast-forward") ||
		pushError.includes("rejected") ||
		pushError.includes("behind");

	if (!needsPull) {
		return { ok: false, output: initialPush.stderr || initialPush.stdout };
	}

	if (onLog) onLog("检测到远端有新提交，正在自动执行变基拉取 (git pull --rebase)...");

	const pullRebase = await runGit(cwd, ["pull", "--rebase"]);
	if (!pullRebase.ok) {
		const rebaseErr = `${pullRebase.stderr} ${pullRebase.stdout}`;
		
		// 检索冲突文件清单
		const conflictDiff = await runGit(cwd, ["diff", "--name-only", "--diff-filter=U"]);
		let conflictFiles = conflictDiff.ok && conflictDiff.stdout.trim()
			? conflictDiff.stdout.trim().split("\n").map((f) => f.trim()).filter(Boolean)
			: [];

		if (conflictFiles.length === 0) {
			const statusRes = await runGit(cwd, ["status", "--porcelain"]);
			if (statusRes.ok && statusRes.stdout.trim()) {
				conflictFiles = statusRes.stdout
					.split("\n")
					.filter((l) => /^(UU|AA|UD|DU|DD|AU|UA)\s+/.test(l.trim()))
					.map((l) => l.trim().slice(3).trim());
			}
		}

		const filesListText = conflictFiles.length > 0
			? `\n\n📌 **发生冲突的文件 (${conflictFiles.length} 个)**：\n${conflictFiles.map((f) => `- \`${f}\``).join("\n")}`
			: "";

		const conflictOutput = `⚠️ **远端有新提交，拉取变基 (git pull --rebase) 时与本地提交产生代码冲突！**${filesListText}

🚨 **【代码冲突解决核心铁律（重中之重）】**：
1. **严禁直接无脑使用 \`--theirs\` 或 \`--ours\`**：绝对不要盲目使用其中一方覆盖另一方，否则极易覆盖远端同事的代码或丢失本地修复！
2. **必须根据对比修改和上下文解决冲突**：
   - 逐个打开冲突文件，对照 \`<<<<<<< HEAD\`（远端基线）与 \`>>>>>>>\`（本地提交）的具体改动；
   - 结合周围类、函数、接口调用与业务上下文，理解两边的意图后逐行融合成正确的最终代码。

🛠️ **解决冲突操作步骤**：
1. 对比并手工/智能修改上述冲突文件，消除所有冲突标记；
2. 执行 \`git add <已解决文件>\` 标记冲突已解决；
3. 执行 \`git rebase --continue\` 完成变基；
4. 变基成功后重新执行 \`/commit-push\` 推送至远端；
（若需放弃本次变基恢复原状，可执行 \`git rebase --abort\`）。\n\n底层详细输出：\n${rebaseErr}`;

		return {
			ok: false,
			output: conflictOutput,
			hasConflict: true,
			conflictFiles,
		};
	}

	if (onLog) onLog("变基拉取成功（无代码冲突），正在重新推送到远端...");
	const retryPush = await runGit(cwd, ["push"]);
	if (retryPush.ok) {
		return {
			ok: true,
			output: "远端有新提交，已自动完成 git pull --rebase 变基并成功推送到远端！",
			autoRebased: true,
		};
	}

	return { ok: false, output: retryPush.stderr || retryPush.stdout };
}