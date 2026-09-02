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

export async function pushCurrentBranch(cwd: string): Promise<{ ok: boolean; output: string }> {
	const res = await runGit(cwd, ["push"]);
	return { ok: res.ok, output: res.ok ? res.stdout : res.stderr };
}