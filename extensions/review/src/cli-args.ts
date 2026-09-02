/**
 * Parse `/review` command arguments.
 */

export interface ParsedReviewArgs {
	/** Freeform user request: review focus, PR url, or context. */
	input?: string;
	/** Dry-run: print resolved plan without spawning. */
	noSpawn: boolean;
	/** Single-agent fast mode: one reviewer, no gate. */
	lite: boolean;
	/** Dedicated performance review mode: perf-reviewer with benchmark capabilities. */
	perf: boolean;
	/** Override the gate model for this run (otherwise config.gate.model). */
	gateModel?: string;
}

const LEGACY_VALUED_FLAGS = new Set([
	"--threshold",
	"--reviewer",
	"--score-per-issue",
	"--diff",
]);

export function parseReviewArgs(raw: string): ParsedReviewArgs {
	const tokens = tokenize(raw);
	const result: ParsedReviewArgs = { noSpawn: false, lite: false, perf: false };
	const inputParts: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (LEGACY_VALUED_FLAGS.has(t)) {
			i++;
			continue;
		}
		if (t === "--no-spawn") {
			result.noSpawn = true;
			continue;
		}
		if (t === "--lite") {
			result.lite = true;
			continue;
		}
		if (t === "--perf" || t === "--performance") {
			result.perf = true;
			continue;
		}
		if (t === "--gate-model") {
			const id = tokens[++i];
			if (id) result.gateModel = id;
			continue;
		}
		if (t.startsWith("-")) {
			continue;
		}
		inputParts.push(t);
	}

	const input = inputParts.join(" ").trim();
	if (input.length > 0) {
		result.input = input;
	}

	return result;
}

function tokenize(raw: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (quote) {
			if (c === quote) {
				quote = null;
			} else {
				cur += c;
			}
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			continue;
		}
		if (/\s/.test(c)) {
			if (cur.length > 0) {
				out.push(cur);
				cur = "";
			}
			continue;
		}
		cur += c;
	}
	if (cur.length > 0) out.push(cur);
	return out;
}