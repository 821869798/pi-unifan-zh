/**
 * JSON Schema fragments injected as `outputSchema` on each reviewer and the
 * gate. Kept in sync with src/schema.ts (used by the legacy spawn pipeline).
 *
 * The plugin no longer reads reviewer Markdown text; the workflowScript
 * receives validated `result.structuredOutput` from pi-subagents.
 */
import type { IssueSeverity, IssueCategory, Verdict } from "./types.js";

export type JsonSchema = Record<string, unknown>;

const SEVERITY: IssueSeverity[] = ["blocker", "major", "minor", "nit"];
const CATEGORY: IssueCategory[] = [
	"compliance",
	"bug",
	"convention",
	"history",
	"security",
	"performance",
	"docs",
	"other",
];
const VERDICT: Verdict[] = ["approve", "request_changes", "comment"];

/**
 * Stable JSON Schema describing the structured output of every reviewer.
 * `status` distinguishes runtime `ok` (tool succeeded) from business
 * `limited/skipped` (no findings because of missing context, not silence).
 */
export const REVIEWER_OUTPUT_SCHEMA: JsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["status", "issues", "summary", "coverage"],
	properties: {
		status: {
			type: "string",
			enum: ["ok", "limited", "skipped"],
			description:
				"ok = reviewer produced findings normally; limited = could not run some checks (still may have issues); skipped = lane does not apply.",
		},
		issues: {
			type: "array",
			maxItems: 200,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["file", "category", "severity", "confidence", "evidence", "fingerprint"],
				properties: {
					file: { type: "string", minLength: 1, maxLength: 500 },
					line: { type: "integer", minimum: 1 },
					relatedChangedLine: { type: "integer", minimum: 1 },
					category: { type: "string", enum: CATEGORY },
					severity: { type: "string", enum: SEVERITY },
					confidence: { type: "integer", minimum: 1, maximum: 10 },
					evidence: { type: "string", minLength: 1, maxLength: 280 },
					fingerprint: {
						type: "string",
						minLength: 1,
						maxLength: 80,
						description:
							"Stable id (file:line:category[:short-hash-of-evidence]) so the gate can dedupe across reviewers.",
					},
				},
			},
		},
		summary: { type: "string", minLength: 1, maxLength: 2000 },
		coverage: {
			type: "object",
			additionalProperties: false,
			required: ["filesChecked", "commandsRun", "limitations"],
			properties: {
				filesChecked: { type: "array", items: { type: "string" } },
				commandsRun: { type: "array", items: { type: "string" } },
				limitations: {
					type: "array",
					items: { type: "string" },
					description: "Plain-language reasons for limited/skipped status.",
				},
			},
		},
	},
};

/**
 * Stable JSON Schema describing the gate's structured output. Adds
 * `dispositions` so every candidate (kept/dropped/merged) is auditable.
 */
export const GATE_OUTPUT_SCHEMA: JsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["status", "verdict", "issues", "dispositions", "reason"],
	properties: {
		status: {
			type: "string",
			enum: ["ok", "limited", "skipped"],
		},
		verdict: { type: "string", enum: VERDICT },
		issues: {
			type: "array",
			maxItems: 500,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["file", "category", "severity", "confidence", "evidence", "fingerprint"],
				properties: {
					file: { type: "string", minLength: 1, maxLength: 500 },
					line: { type: "integer", minimum: 1 },
					relatedChangedLine: { type: "integer", minimum: 1 },
					category: { type: "string", enum: CATEGORY },
					severity: { type: "string", enum: SEVERITY },
					confidence: { type: "integer", minimum: 1, maximum: 10 },
					evidence: { type: "string", minLength: 1, maxLength: 280 },
					fingerprint: { type: "string", minLength: 1, maxLength: 80 },
				},
			},
		},
		dispositions: {
			type: "array",
			description:
				"Per-candidate disposition: kept | dropped | merged. Required for every reviewer candidate so reports can audit threshold/dedupe/verify decisions.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["fingerprint", "decision", "originalConfidence", "finalConfidence", "reason"],
				properties: {
					fingerprint: { type: "string", minLength: 1, maxLength: 80 },
					decision: { type: "string", enum: ["kept", "dropped", "merged"] },
					originalConfidence: { type: "integer", minimum: 1, maximum: 10 },
					finalConfidence: { type: "integer", minimum: 1, maximum: 10 },
					sourceReviewers: {
						type: "array",
						items: { type: "string" },
					},
					reason: { type: "string", minLength: 1, maxLength: 500 },
				},
			},
		},
		reason: { type: "string", minLength: 1, maxLength: 500 },
		coverage: {
			type: "object",
			additionalProperties: false,
			properties: {
				limitations: { type: "array", items: { type: "string" } },
			},
		},
	},
};

/**
 * Serialize a JSON Schema as a JS string literal safe to embed in the
 * generated workflowScript. Avoids escaping mistakes from JSON.stringify +
 * double-quoting gymnastics.
 */
export function serializeSchemaForJs(schema: JsonSchema): string {
	return JSON.stringify(schema);
}

/**
 * Serialize a JSON Schema as a multi-line JS object literal for embedding
 * directly in the generated workflowScript (v0.7.3). The single-line form
 * produced 1400+ character lines — the exact spot where the main agent's
 * copy slipped a character (PR 19291 incident, `"maxLength":80",`).
 * Multi-line keeps every line short enough to copy reliably.
 */
export function serializeSchemaAsObjectLiteral(schema: JsonSchema, indent = "  "): string {
	const json = JSON.stringify(schema, null, 2);
	// Indent every line so the literal sits cleanly inside the script body.
	return json
		.split("\n")
		.map((line, i) => (i === 0 ? line : indent + line))
		.join("\n");
}