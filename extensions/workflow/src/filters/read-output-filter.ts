export interface ReadFilterInput {
	path: string;
	output: string;
	isError: boolean;
	isImage?: boolean;
}

export interface ReadFilterResult {
	filtered: boolean;
	output: string;
	originalBytes: number;
	filteredBytes: number;
	strategy: string;
}

const MAX_READ_CHARS = 16000;

export function filterReadOutput(input: ReadFilterInput): ReadFilterResult {
	const original = input.output;
	const originalBytes = Buffer.byteLength(original, "utf-8");

	if (input.isImage || input.isError || original.length <= MAX_READ_CHARS) {
		return {
			filtered: false,
			output: original,
			originalBytes,
			filteredBytes: originalBytes,
			strategy: "none",
		};
	}

	const normalizedPath = input.path.toLowerCase().replace(/\\/g, "/");

	// Compress package-lock.json
	if (normalizedPath.endsWith("package-lock.json") || normalizedPath.endsWith("yarn.lock")) {
		try {
			if (normalizedPath.endsWith("package-lock.json")) {
				const parsed = JSON.parse(original);
				const depsCount = Object.keys(parsed.packages || parsed.dependencies || {}).length;
				const summary = JSON.stringify(
					{
						name: parsed.name,
						version: parsed.version,
						lockfileVersion: parsed.lockfileVersion,
						totalPackagesCount: depsCount,
						note: "Full package-lock content compressed by workflow context optimizer. Use npm list or inspect individual packages if needed.",
					},
					null,
					2,
				);
				const filteredBytes = Buffer.byteLength(summary, "utf-8");
				return {
					filtered: true,
					output: summary,
					originalBytes,
					filteredBytes,
					strategy: "lockfile-summary",
				};
			}
		} catch {}
	}

	// General huge file truncation
	const lines = original.split("\n");
	if (lines.length > 300) {
		const head = lines.slice(0, 100).join("\n");
		const tail = lines.slice(-50).join("\n");
		const truncated = lines.length - 150;
		const filteredOutput = `${head}\n\n... [${truncated} lines collapsed by workflow filter. Read specific slices if needed] ...\n\n${tail}`;
		const filteredBytes = Buffer.byteLength(filteredOutput, "utf-8");
		return {
			filtered: true,
			output: filteredOutput,
			originalBytes,
			filteredBytes,
			strategy: "large-file-slice",
		};
	}

	return {
		filtered: false,
		output: original,
		originalBytes,
		filteredBytes: originalBytes,
		strategy: "none",
	};
}
