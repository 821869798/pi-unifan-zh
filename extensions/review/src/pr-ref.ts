/**
 * Extract a GitHub PR reference from freeform user input (CC-style).
 */

/** Normalize punctuation that often appears when typing PR URLs in CJK IME. */
export function normalizeUserInput(text: string): string {
	return text.replace(/[，,;]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Regex matching `github.com/<owner>/<repo>/pull/<number>` (used for full parsing). */
export const PR_REF_REGEX = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i;

/**
 * Return a `gh pr diff` ref: full PR URL, or PR number string.
 * Returns null when no PR reference is detected.
 */
export function extractPrRef(text: string): string | null {
	const normalized = normalizeUserInput(text);
	if (!normalized) return null;

	const fullUrl = normalized.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i);
	if (fullUrl) return fullUrl[0];

	const shortUrl = normalized.match(/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i);
	if (shortUrl) return `https://${shortUrl[0]}`;

	const pullPath = normalized.match(/\bpull\/(\d{1,10})\b/i);
	if (pullPath) return pullPath[1];

	const prTag = normalized.match(/\bPR\s*#?(\d{1,10})\b/i);
	if (prTag) return prTag[1];

	const first = normalized.split(/\s+/)[0] ?? "";
	if (/^#?\d{1,10}$/.test(first)) {
		return first.replace(/^#/, "");
	}

	return null;
}
