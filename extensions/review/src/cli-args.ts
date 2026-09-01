/**
 * Parse `/review` command arguments.
 *
 * Surface is intentionally minimal:
 *   - `--lite`      fast single-agent review (no fan-out, no gate)
 *   - `--no-spawn`  hidden dry-run (prints the resolved plan, no subprocess)
 *   - trailing freeform text → user review request (focus / requirements /
 *     PR url / context), injected into reviewers and gate via target.userContext
 *     (see src/prep.ts and src/git-input.ts)
 *
 * Removed flags (--threshold / --reviewer / --score-per-issue / --diff) are
 * accepted-but-ignored for graceful degradation of old invocations: a valued
 * legacy flag also consumes its next token so its value does not leak into
 * `input`. Those capabilities now live in config.json (`/review-config`).
 * `--gate-model <id>` remains an active per-run override.
 */

export interface ParsedReviewArgs {
	/** Freeform user request: review focus, PR url, or context. */
	input?: string;
	/** Dry-run: print resolved plan without spawning. */
	noSpawn: boolean;
	/** Single-agent fast mode: one reviewer, no gate. */
	lite: boolean;
	/** Override the gate model for this run (otherwise config.gate.model). */
	gateModel?: string;
}

/** Removed valued flags — silently skip flag + value to keep input clean. */
const LEGACY_VALUED_FLAGS = new Set([
	"--threshold",
	"--reviewer",
	"--score-per-issue",
	"--diff",
]);

export function parseReviewArgs(raw: string): ParsedReviewArgs {
	const tokens = tokenize(raw);
	const result: ParsedReviewArgs = { noSpawn: false, lite: false };
	const inputParts: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (LEGACY_VALUED_FLAGS.has(t)) {
			i++; // consume the value too
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
		if (t === "--gate-model") {
			const id = tokens[++i];
			if (id) result.gateModel = id;
			continue;
		}
		if (t.startsWith("-")) {
			continue; // ignore other legacy / unknown flags
		}
		inputParts.push(t);
	}

	const input = inputParts.join(" ").trim();
	if (input.length > 0) {
		result.input = input;
	}

	return result;
}

/** Split on whitespace preserving quoted segments. */
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
