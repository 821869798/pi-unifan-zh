/**
 * Target workspace prep — clone (or worktree) the target repository so
 * reviewer children can read its source, history and unchanged files.
 *
 * Real failure (PR #18689): reviewers shared cwd with the plugin repo, so
 * `history-context` and `code-comments` had no relevant code. The plugin now
 *   - for PRs: shallow-clones `owner/repo` into a scratch dir (gh first so
 *     private repos use the gh credential), checks out the PR head from
 *     FETCH_HEAD, and verifies the landed SHA against the diff's head SHA.
 *   - for local-git dirty: uses the user's cwd directly (already correct).
 *   - for local-git clean vs default branch: uses the user's cwd after
 *     `git fetch origin <base>`.
 *
 * The workspace is **read-only by convention**: reviewers are not given
 * write tools and the plugin never modifies it.
 *
 * A failed PR clone is a hard error (not a silent fallback to the user's
 * cwd): a fresh GitHub diff plus a stale local checkout is the #1 false
 * positive source observed in the field (diff@new, files@old).
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePrRepo } from "./review-report.js";

export type RunCmd = (
	cmd: string,
	args: string[],
	opts: { cwd: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

let _runCmd: RunCmd = defaultRunCmd;
export function setTargetWorkspaceCmd(fn: RunCmd): void {
	_runCmd = fn;
}
export function resetTargetWorkspaceCmd(): void {
	_runCmd = defaultRunCmd;
}

async function defaultRunCmd(
	cmd: string,
	args: string[],
	opts: { cwd: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		try {
			const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout?.setEncoding("utf-8");
			child.stderr?.setEncoding("utf-8");
			child.stdout?.on("data", (d: string) => (stdout += d));
			child.stderr?.on("data", (d: string) => (stderr += d));
			child.on("error", () => resolve({ stdout, stderr, exitCode: 1 }));
			child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
		} catch {
			resolve({ stdout: "", stderr: "spawn failed", exitCode: 1 });
		}
	});
}

/** Allocate a scratch root under the OS tmpdir; created on disk. */
export function allocateWorkspaceRoot(prefix = "pi-review-ws"): string {
	const root = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(root, { recursive: true });
	return root;
}

/** Best-effort cleanup; ignores errors. */
export function removeWorkspaceRoot(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

export interface WorkspaceResult {
	/** Absolute path reviewers should use as cwd. */
	workspacePath: string;
	/** True when `git log` / `blame` will work in the workspace. */
	historyAvailable: boolean;
	/** Optional failure note — when set, reviewers must `skipped` the affected lane. */
	warning?: string;
	/** Whether we cloned (true) or reused the user cwd (false). */
	cloned: boolean;
	/** HEAD SHA landed in the workspace, when determinable. */
	workspaceHeadSha?: string;
}

/**
 * Resolve the right workspace for a given target. `cwd` is the user's cwd.
 * Pure function with side effects limited to fs + git/gh subprocesses.
 */
export async function prepareWorkspace(input: {
	cwd: string;
	target: {
		kind: "pr" | "diff-file" | "local-git";
		prRef?: string;
		/** Diff-side head SHA to verify the checkout against. */
		expectedHeadSha?: string;
	};
}): Promise<WorkspaceResult> {
	const { cwd, target } = input;

	if (target.kind === "local-git") {
		// Reuse the user's cwd; reviewers will read source directly.
		const inRepo = await isGitRepo(cwd);
		return {
			workspacePath: cwd,
			historyAvailable: inRepo,
			cloned: false,
			warning: inRepo ? undefined : "Not a git repository — history-context will skip.",
		};
	}

	if (target.kind !== "pr" || !target.prRef) {
		return {
			workspacePath: cwd,
			historyAvailable: false,
			cloned: false,
			warning: "PR target missing prRef — reviewers will see only the diff.",
		};
	}

	const parsed = parsePrRepo(target.prRef);
	if (!parsed) {
		return {
			workspacePath: cwd,
			historyAvailable: false,
			cloned: false,
			warning: "Could not parse PR URL — reviewers will see only the diff.",
		};
	}

	const root = allocateWorkspaceRoot();
	const cloneDir = join(root, `${parsed.repo}-${parsed.number}`);
	mkdirSync(cloneDir, { recursive: true });

	// Clone (gh first so private repos ride the gh credential; plain https
	// fallback for anonymous/public setups). depth 50 keeps history-context
	// usable without a full clone.
	const url = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
	const ghClone = await _runCmd(
		"gh",
		["repo", "clone", `${parsed.owner}/${parsed.repo}`, cloneDir, "--", "--depth", "50"],
		{ cwd: root },
	);
	const clone = ghClone.exitCode === 0
		? ghClone
		: await _runCmd("git", ["clone", "--depth", "50", url, cloneDir], { cwd: root });
	if (clone.exitCode !== 0) {
		removeWorkspaceRoot(root);
		throw new Error(
			`pi-review: could not clone ${parsed.owner}/${parsed.repo} (${(ghClone.stderr || clone.stderr).trim().slice(0, 200)}). A fresh diff over a stale local checkout produces false positives, so the review stops here — check gh auth / network and re-run.`,
		);
	}

	// Fetch the PR head into FETCH_HEAD and detach onto it (no named branch →
	// nothing stale can survive between runs).
	const headFetch = await _runCmd(
		"git",
		["fetch", "origin", `pull/${parsed.number}/head`, "--quiet"],
		{ cwd: cloneDir },
	);
	if (headFetch.exitCode !== 0) {
		removeWorkspaceRoot(root);
		throw new Error(
			`pi-review: git fetch pull/${parsed.number}/head failed (${headFetch.stderr.trim().slice(0, 200)}) — aborting instead of reviewing a mismatched checkout.`,
		);
	}
	const fetchHead = (await _runCmd("git", ["rev-parse", "FETCH_HEAD"], { cwd: cloneDir })).stdout.trim();
	if (
		target.expectedHeadSha &&
		fetchHead &&
		fetchHead !== target.expectedHeadSha
	) {
		// One refetch — a force-push may have raced the clone.
		const retry = await _runCmd(
			"git",
			["fetch", "origin", `pull/${parsed.number}/head`, "--quiet"],
			{ cwd: cloneDir },
		);
		const retryHead = retry.exitCode === 0
			? (await _runCmd("git", ["rev-parse", "FETCH_HEAD"], { cwd: cloneDir })).stdout.trim()
			: "";
		if (retryHead && retryHead !== target.expectedHeadSha) {
			removeWorkspaceRoot(root);
			throw new Error(
				`pi-review: PR ${parsed.number} head moved to ${retryHead.slice(0, 12)} while the diff was captured at ${target.expectedHeadSha.slice(0, 12)} — re-run /review to get a consistent pair.`,
			);
		}
	}
	const headCheckout = await _runCmd("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: cloneDir });
	if (headCheckout.exitCode !== 0) {
		removeWorkspaceRoot(root);
		throw new Error(
			`pi-review: checkout of PR ${parsed.number} head failed (${headCheckout.stderr.trim().slice(0, 200)}).`,
		);
	}

	const workspaceHeadSha = await safeHead(cloneDir);
	return { workspacePath: cloneDir, historyAvailable: true, cloned: true, workspaceHeadSha };
}

async function safeHead(cwd: string): Promise<string | undefined> {
	const r = await _runCmd("git", ["rev-parse", "HEAD"], { cwd });
	if (r.exitCode !== 0) return undefined;
	return r.stdout.trim() || undefined;
}

async function isGitRepo(cwd: string): Promise<boolean> {
	const r = await _runCmd("git", ["rev-parse", "--git-dir"], { cwd });
	return r.exitCode === 0;
}

/** Optional: write a `.pi-review-meta.json` so reviewers can find the run dir. */
export function writeWorkspaceMarker(workspacePath: string, payload: Record<string, unknown>): void {
	const path = join(workspacePath, ".pi-review-meta.json");
	try {
		writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf-8");
	} catch {
		/* read-only fs, etc. */
	}
}

/** Quiet helper to remove the marker when the workspace is torn down. */
export function clearWorkspaceMarker(workspacePath: string): void {
	try {
		rmSync(join(workspacePath, ".pi-review-meta.json"), { force: true });
	} catch {
		/* ignore */
	}
}
