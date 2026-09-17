export interface BashFilterInput {
	command: string;
	output: string;
	isError: boolean;
}

export interface BashFilterResult {
	filtered: boolean;
	output: string;
	originalBytes: number;
	filteredBytes: number;
	strategy: string;
}

const MAX_OUTPUT_CHARS = 4000;
const HEAD_LINES = 25;
const TAIL_LINES = 35;

export function filterBashOutput(input: BashFilterInput): BashFilterResult {
	const original = input.output;
	const originalBytes = Buffer.byteLength(original, "utf-8");

	const lines = original.split("\n");

	// Don't filter small outputs (neither excessive chars nor excessive lines)
	if (original.length <= MAX_OUTPUT_CHARS && lines.length <= HEAD_LINES + TAIL_LINES) {
		return {
			filtered: false,
			output: original,
			originalBytes,
			filteredBytes: originalBytes,
			strategy: "none",
		};
	}

	if (lines.length <= HEAD_LINES + TAIL_LINES) {
		return {
			filtered: false,
			output: original,
			originalBytes,
			filteredBytes: originalBytes,
			strategy: "none",
		};
	}

	const head = lines.slice(0, HEAD_LINES).join("\n");
	const tail = lines.slice(-TAIL_LINES).join("\n");
	const truncatedLineCount = lines.length - HEAD_LINES - TAIL_LINES;

	const filteredOutput = `${head}\n\n... [${truncatedLineCount} lines truncated by workflow context optimizer to preserve token budget] ...\n\n${tail}`;
	const filteredBytes = Buffer.byteLength(filteredOutput, "utf-8");

	return {
		filtered: true,
		output: filteredOutput,
		originalBytes,
		filteredBytes,
		strategy: "head-tail-truncation",
	};
}
