import path from "node:path";
import { mkdir } from "node:fs/promises";

export type ArtifactType = "brainstorm" | "plan" | "solution" | "checkpoint";

export interface ArtifactHelperOptions {
	repoRoot: string;
	artifactType: ArtifactType;
	date?: string;
	topic?: string;
	ensureDir?: boolean;
}

export interface ArtifactHelperResult {
	path: string;
	relativePath: string;
	exists: boolean;
	createdDir: boolean;
}

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/[\s_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function getTodayDateString(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function resolveArtifactRelativePath(
	artifactType: ArtifactType,
	date: string,
	topic: string,
): string {
	const slug = slugify(topic) || "general";
	switch (artifactType) {
		case "brainstorm":
			return path.join("docs", "brainstorms", `${date}-${slug}-requirements.md`);
		case "plan":
			return path.join("docs", "plans", `${date}-${slug}-plan.md`);
		case "solution":
			return path.join("docs", "solutions", `${date}-${slug}.md`);
		case "checkpoint":
			return path.join(".context", "checkpoints", `${slug}.json`);
	}
}

export async function resolveArtifactPath(
	options: ArtifactHelperOptions,
): Promise<ArtifactHelperResult> {
	const date = options.date || getTodayDateString();
	const topic = options.topic || "unnamed";
	const relPath = resolveArtifactRelativePath(options.artifactType, date, topic);
	const fullPath = path.resolve(options.repoRoot, relPath);
	let createdDir = false;

	if (options.ensureDir) {
		const dir = path.dirname(fullPath);
		await mkdir(dir, { recursive: true });
		createdDir = true;
	}

	return {
		path: fullPath,
		relativePath: relPath.replace(/\\/g, "/"),
		exists: false,
		createdDir,
	};
}
