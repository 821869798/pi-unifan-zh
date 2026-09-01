/**
 * Target workspace + run manifest prep.
 *
 * The extension owns diff acquisition + target repo checkout so the
 * main-agent directive stays a single `subagent` call. Reviewer children
 * share the prepared workspace as their cwd; git history, file lookups, and
 * `gh pr diff` all work without the LLM re-fetching anything.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PR_REF_REGEX } from "./pr-ref.js";
import type { ReviewTarget } from "./types.js";

/** Hard cap on prepared workspace age before pruning (ms). */
export const WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000;

export interface RunManifest {
	/** Stable id used in filenames, log lines, and the report entry. */
	runId: string;
	/** Target label (e.g. "PR 18689 (agent-fetch)"). */
	targetLabel: string;
	targetKind: ReviewTarget["kind"];
	prRef?: string;
	/** Absolute path to the reviewer-facing diff (already captured). */
	diffPath: string;
	/** SHA-256 of `diffPath` contents (lowercase hex). */
	diffSha256: string;
	/** Repo-relative changed paths (parsed from `diffPath`, not from cwd). */
	changedFiles: string[];
	/** Whether the diff is exclusively docs/markdown. */
	docsOnly: boolean;
	/** Repo-relative rule file paths (AGENTS.md / CLAUDE.md / .pi/rules/*). */
	rulePaths: string[];
	/** True when reviewer `git log`/`blame` will work in the workspace. */
	historyAvailable: boolean;
	/** Detection mode: which path produced the diff. `git-pr-fallback` is
	 *  legacy-only (pre-0.7.1) — PR diffs now come exclusively from gh. */
	mode: "gh-pr-diff" | "git-pr-fallback" | "local-uncommitted" | "local-vs-default";
	/** Base + head SHA when known (PR mode or local-vs-default). */
	baseSha?: string;
	headSha?: string;
	mergeBase?: string;
	/** Absolute path to the prepared target workspace. */
	workspacePath: string;
	/** HEAD SHA actually checked out in the workspace, when determinable. */
	workspaceHeadSha?: string;
	/** Non-fatal workspace prep note surfaced in the report. */
	workspaceWarning?: string;
	/** True when the workspace is a plugin-owned tmpdir clone (safe to
	 *  reclaim after the report renders); false = the user's cwd. */
	workspaceCloned?: boolean;
	/** Absolute path to the run directory (manifest + diff + history live here). */
	runDir: string;
	createdAt: number;
	/** Lanes adaptive routing dropped up front (id + reason), for report coverage. */
	skippedReviewers?: Array<{ id: string; reason: string }>;
	/** Reviewer ids fanned out by THIS run — the report tool rejects findings from anything else. */
	reviewerIds?: string[];
	/** Non-fatal note about the acquired diff (e.g. stale-base fallback). */
	diffWarning?: string;
}

export interface PrepInput {
	cwd: string;
	target: ReviewTarget;
	prRepo?: { owner: string; repo: string };
}

/** Per-reviewer path inside `.pi/pi-review/runs/<runId>/`. */
export function runDirFor(cwd: string, runId: string): string {
	return join(cwd, ".pi", "pi-review", "runs", runId);
}

/** Create the prepared run dir + workspace. */
export function ensureRunDir(cwd: string, runId: string): string {
	const runDir = runDirFor(cwd, runId);
	mkdirSync(runDir, { recursive: true });
	return runDir;
}

/** Prune run dirs older than `WORKSPACE_TTL_MS`. */
export function pruneStaleRuns(cwd: string, now = Date.now()): string[] {
	const runsRoot = join(cwd, ".pi", "pi-review", "runs");
	if (!existsSync(runsRoot)) return [];
	const removed: string[] = [];
	for (const entry of safeListDir(runsRoot)) {
		const path = join(runsRoot, entry);
		const stat = safeStat(path);
		if (!stat) continue;
		if (now - stat.mtimeMs > WORKSPACE_TTL_MS) {
			try {
				rmSync(path, { recursive: true, force: true });
				removed.push(path);
			} catch {
				/* ignore */
			}
		}
	}
	return removed;
}

function safeListDir(p: string): string[] {
	try {
		return readdirSync(p);
	} catch {
		return [];
	}
}
void safeListDir; // keep tree-shaker honest

function safeStat(p: string): { mtimeMs: number } | null {
	try {
		return statSync(p);
	} catch {
		return null;
	}
}
void safeStat;

/** Stable, URL-safe run id (timestamp + 6 random hex chars). */
export function generateRunId(now = Date.now()): string {
	const rand = Math.random().toString(16).slice(2, 8).padEnd(6, "0");
	return `${now.toString(36)}-${rand}`;
}

export interface GhExec {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** Spawn `gh` (or `git`) and capture output. Tests inject a fake. */
export type RunCmd = (
	cmd: string,
	args: string[],
	opts: { cwd: string },
) => Promise<GhExec>;

let _runCmd: RunCmd = defaultRunCmd;
export function setRunCmd(fn: RunCmd): void {
	_runCmd = fn;
}
export function resetRunCmd(): void {
	_runCmd = defaultRunCmd;
}

async function defaultRunCmd(cmd: string, args: string[], opts: { cwd: string }): Promise<GhExec> {
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
		} catch (err) {
			resolve({ stdout: "", stderr: err instanceof Error ? err.message : "spawn failed", exitCode: 1 });
		}
	});
}

export function sha256Hex(buf: string | Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

/** Parse changed paths + docsOnly flag from a captured diff. */
export function parseChangedFilesFromDiff(diff: string): {
	files: string[];
	docsOnly: boolean;
	additions: number;
	deletions: number;
} {
	const files: string[] = [];
	const seen = new Set<string>();
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
			const file = m?.[2] ?? "";
			if (file && !seen.has(file)) {
				seen.add(file);
				files.push(file);
			}
		} else if (line.startsWith("+") && !line.startsWith("+++")) {
			additions++;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			deletions++;
		}
	}
	const docsOnly =
		files.length > 0 &&
		files.every((f) =>
			/\.(md|mdx|txt|rst)$/i.test(f) ||
			f.startsWith("docs/") ||
			f.startsWith(".agents/") ||
			f.startsWith(".pi/") ||
			f.includes("/docs/") ||
			/CHANGELOG|LICENSE|README/i.test(f),
		);
	return { files, docsOnly, additions, deletions };
}

export function discoverRulePathsLocal(cwd: string): string[] {
	const candidates = ["AGENTS.md", "CLAUDE.md", "CONVENTIONS.md", ".pi/conventions.md"];
	const found: string[] = [];
	for (const name of candidates) {
		if (existsSync(join(cwd, name))) found.push(name);
	}
	for (const rulesDir of [join(cwd, ".pi", "rules"), join(cwd, ".agents", "rules")]) {
		if (!existsSync(rulesDir)) continue;
	try {
		const list = readdirSync(rulesDir) as string[];
			for (const entry of list) {
				if (typeof entry === "string" && entry.endsWith(".md")) {
					found.push(
						rulesDir.includes(".agents/rules") ? join(".agents/rules", entry) : join(".pi/rules", entry),
					);
				}
			}
		} catch {
			/* ignore */
		}
	}
	return [...new Set(found)];
}

/** Parse a GitHub PR URL or "owner/repo#number" into structured pieces. */
export function parsePrRepo(prRef: string): { owner: string; repo: string; number: string } | null {
	const m = prRef.match(PR_REF_REGEX);
	if (!m) return null;
	return { owner: m[1]!, repo: m[2]!, number: m[3]! };
}

void PR_REF_REGEX;

/** Read a manifest from disk (paranoia: corrupted files throw). */
export function readManifest(runDir: string): RunManifest {
	const path = join(runDir, "manifest.json");
	const raw = readFileSync(path, "utf-8");
	return JSON.parse(raw) as RunManifest;
}

export function writeManifest(runDir: string, manifest: RunManifest): void {
	writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/** Write the diff body to a deterministic path inside the run dir. */
export function writeDiff(runDir: string, diff: string): string {
	const path = join(runDir, "change.diff");
	writeFileSync(path, diff, "utf-8");
	return path;
}

/** Cheap scratch path under tmp/ — never used by reviewers. */
export function localScratchDir(prefix: string): string {
	const dir = join(tmpdir(), `pi-review-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export const _INTERNAL = {
	WORKSPACE_TTL_MS,
};