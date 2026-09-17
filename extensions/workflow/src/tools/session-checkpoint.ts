import path from "node:path";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { slugify } from "./artifact-helper.js";

export interface CheckpointData {
	planPath?: string;
	planSlug: string;
	completedUnits: string[];
	failedUnit?: string;
	error?: string;
	createdAt: string;
	updatedAt: string;
}

export interface SessionCheckpointOptions {
	operation: "save" | "load" | "list" | "fail" | "retry";
	repoRoot: string;
	planPath?: string;
	planSlug?: string;
	completedUnits?: string[];
	failedUnit?: string;
	error?: string;
}

export interface SessionCheckpointResult {
	operation: string;
	success: boolean;
	checkpoint?: CheckpointData | null;
	checkpoints?: CheckpointData[];
	message?: string;
}

function getCheckpointDir(repoRoot: string): string {
	return path.resolve(repoRoot, ".context", "checkpoints");
}

function getCheckpointFilePath(repoRoot: string, slug: string): string {
	return path.join(getCheckpointDir(repoRoot), `${slug}.json`);
}

function extractSlug(options: SessionCheckpointOptions): string {
	if (options.planSlug) {
		return slugify(options.planSlug);
	}
	if (options.planPath) {
		const base = path.basename(options.planPath, path.extname(options.planPath));
		return slugify(base);
	}
	return "default-session";
}

export async function executeSessionCheckpoint(
	options: SessionCheckpointOptions,
): Promise<SessionCheckpointResult> {
	const dir = getCheckpointDir(options.repoRoot);
	const slug = extractSlug(options);
	const filePath = getCheckpointFilePath(options.repoRoot, slug);

	switch (options.operation) {
		case "save": {
			await mkdir(dir, { recursive: true });
			let existing: CheckpointData | null = null;
			try {
				const content = await readFile(filePath, "utf-8");
				existing = JSON.parse(content);
			} catch {}

			const now = new Date().toISOString();
			const mergedUnits = Array.from(
				new Set([
					...(existing?.completedUnits || []),
					...(options.completedUnits || []),
				]),
			);

			const checkpoint: CheckpointData = {
				planPath: options.planPath || existing?.planPath,
				planSlug: slug,
				completedUnits: mergedUnits,
				failedUnit: undefined,
				error: undefined,
				createdAt: existing?.createdAt || now,
				updatedAt: now,
			};

			await writeFile(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
			return {
				operation: "save",
				success: true,
				checkpoint,
				message: `Checkpoint saved for ${slug} (${mergedUnits.length} completed units).`,
			};
		}

		case "load": {
			try {
				const content = await readFile(filePath, "utf-8");
				const checkpoint: CheckpointData = JSON.parse(content);
				return {
					operation: "load",
					success: true,
					checkpoint,
				};
			} catch {
				return {
					operation: "load",
					success: false,
					checkpoint: null,
					message: `No checkpoint found for ${slug}.`,
				};
			}
		}

		case "list": {
			try {
				const files = await readdir(dir);
				const jsonFiles = files.filter((f) => f.endsWith(".json"));
				const checkpoints: CheckpointData[] = [];
				for (const file of jsonFiles) {
					try {
						const raw = await readFile(path.join(dir, file), "utf-8");
						checkpoints.push(JSON.parse(raw));
					} catch {}
				}
				return {
					operation: "list",
					success: true,
					checkpoints,
				};
			} catch {
				return {
					operation: "list",
					success: true,
					checkpoints: [],
				};
			}
		}

		case "fail": {
			await mkdir(dir, { recursive: true });
			let existing: CheckpointData | null = null;
			try {
				const content = await readFile(filePath, "utf-8");
				existing = JSON.parse(content);
			} catch {}

			const now = new Date().toISOString();
			const checkpoint: CheckpointData = {
				planPath: options.planPath || existing?.planPath,
				planSlug: slug,
				completedUnits: existing?.completedUnits || options.completedUnits || [],
				failedUnit: options.failedUnit,
				error: options.error,
				createdAt: existing?.createdAt || now,
				updatedAt: now,
			};

			await writeFile(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
			return {
				operation: "fail",
				success: true,
				checkpoint,
				message: `Recorded failure on unit ${options.failedUnit || "unknown"}.`,
			};
		}

		case "retry": {
			try {
				const content = await readFile(filePath, "utf-8");
				const checkpoint: CheckpointData = JSON.parse(content);
				const now = new Date().toISOString();
				checkpoint.failedUnit = undefined;
				checkpoint.error = undefined;
				checkpoint.updatedAt = now;
				await writeFile(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
				return {
					operation: "retry",
					success: true,
					checkpoint,
					message: `Cleared failure state for ${slug}. Ready to retry.`,
				};
			} catch {
				return {
					operation: "retry",
					success: false,
					message: `No checkpoint found for ${slug} to retry.`,
				};
			}
		}
	}
}
