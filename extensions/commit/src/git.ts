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
): Promise<{ ok: boolean; output: string; autoRebased?: boolean }> {
	const initialPush = await runGit(cwd, ["push"]);
	if (initialPush.ok) {
		return { ok: true, output: initialPush.stdout || "推送成功" };
	}

	const pushError = `${initialPush.stderr} ${initialPush.stdout}`.toLowerCase();
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
		return {
			ok: false,
			output: `远端有新提交，尝试自动变基 (git pull --rebase) 时产生代码冲突。\n${rebaseErr}\n请手动解决冲突后执行 git rebase --continue，或执行 git rebase --abort 撤销变基。`,
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