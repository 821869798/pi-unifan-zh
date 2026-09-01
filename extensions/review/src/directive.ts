/**
 * Build the review directive injected into the main agent (hidden, via
 * `sendMessage` with `display:false` + `triggerTurn:true`).
 *
 * v0.7.0 contract (post-mortem from PR #18689 review):
 *   - chatProgress must be "auto" | "off" | "live-card" — anything else is
 *     rejected by pi-subagents schema validation.
 *   - Every reviewer child declares `cwd` (target workspace) and
 *     `outputSchema` so pi-subagents returns `result.structuredOutput`.
 *   - "inherit" reviewer models are NOT expanded into concrete model ids.
 *     The workflow script leaves `model:` off so the orchestrator keeps the
 *     inheritance link.
 *   - The gate consumes reviewer `structuredOutput` objects directly, never
 *     Markdown code fences.
 *   - Step 3 hands off to the `pi_review_report` tool, which is the only
 *     authoritative report renderer (deterministic code-side verdict).
 */
import { writeFileSync } from "node:fs";

import {
	FALSE_POSITIVE_GUIDANCE,
	LEAN_BUDGETS,
	LEAN_GATE_AGENT,
	leanAgentName,
	resolveLeanBudgets,
	withThinkingSuffix,
	type LeanBudgetSpec,
} from "./lean-agents.js";
import type { ReviewerSpec, ReviewTarget } from "./types.js";

export interface ReviewDirectiveInput {
	target: ReviewTarget;
	reviewers: ReviewerSpec[];
	/** Resolved gate model id (from config.gate.model or --gate-model). */
	gateModel: string;
	/** Optional gate thinking from config (appended as model:thinking). */
	gateThinking?: string;
	threshold: number;
	/** Verdict policy passed to the gate task (code-side authoritative). */
	verdictPolicy?: "strict" | "legacy";
	lite: boolean;
	/** Set false to skip the gate while keeping the full reviewer roster. */
	gateEnabled?: boolean;
	cwd: string;
	/** Absolute path to the plugin-prepared target workspace (reviewer cwd). */
	workspacePath: string;
	/** Absolute path to the run manifest.json. */
	manifestPath: string;
	/** Absolute path to the captured change.diff. */
	diffPath: string;
	/**
	 * Absolute path to write the raw workflowScript text. When set, the raw
	 * script is persisted here and the directive points the main agent at it
	 * (retry path) instead of asking it to re-derive the script from a
	 * double-escaped JSON string — see the 2026-08-25 PR 19395 incident where
	 * the main agent's copy/unescape of the script produced a syntax error
	 * three times and then drifted into hand-debugging.
	 */
	workflowPath?: string;
	/** Optional turnBudget override from config.budgets. */
	budgets?: LeanBudgetSpec;
}

export function buildReviewDirective(input: ReviewDirectiveInput): string {
	const { target, reviewers, gateModel, gateThinking, threshold, lite, cwd, workspacePath, manifestPath, diffPath, workflowPath } = input;
	const policy = input.verdictPolicy ?? "strict";
	const gateOn = !lite && input.gateEnabled !== false;
	const budgets = input.budgets ?? resolveLeanBudgets();
	const gateModelWithThinking = withThinkingSuffix(gateModel, gateThinking);
	const blocks: string[] = [];

	blocks.push("# Code review (token-lean)");
	blocks.push("");
	if (target.userContext?.trim()) {
		blocks.push(`**User request:** ${target.userContext.trim()}`);
		blocks.push("");
	}
	blocks.push(
		`Review the change (${target.label}). The plugin has already prepared the target workspace, diff and run manifest. Run one workflowScript that fans out ${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"}${lite ? " (lite)" : ""}${gateOn ? " + inline gate" : ""}, then call the \`pi_review_report\` tool to finalize the report. Do not re-write or summarize findings in chat.`,
	);
	blocks.push("");
	blocks.push("## Hard rules (do not violate)");
	blocks.push("");
	blocks.push("- Call `subagent` **exactly one** time in this whole review: the Step 2 workflowScript call.");
	blocks.push(
		lite
			? "- Step 2 must be a **single** `subagent({ workflowScript, async:false, ... })` that fans out the lite-reviewer via `runs.all([...])` — never more than one call."
			: gateOn
				? "- Step 2 must be a **single** `subagent({ workflowScript, async:false, ... })` that fans out **all** reviewers via `runs.all([...])` and runs the inline gate via `runs.run(\"gate\", ...)` — never one call per reviewer, never serial waves."
				: "- Step 2 must be a **single** `subagent({ workflowScript, async:false, ... })` that fans out **all** reviewers via `runs.all([...])` (gate disabled in config) — never one call per reviewer, never serial waves.",
	);
	blocks.push(
		"- **Do not retry** or re-spawn if a reviewer times out, hits its turnBudget, returns partial output, or fails — `runs.all` collects failures as `{ ok:false }`; the script continues and you mark failures in the report.",
	);
	const retryScriptHint = workflowPath ? `Read-tool \`${workflowPath}\`` : "the Read tool on the workflow.js file";
	blocks.push(
		"- **Exception (script-level failure):** if the `subagent` call is rejected because the `workflowScript` **fails to parse** (no reviewer ever started — e.g. a syntax error in the script literal), retry **once**: use the " + retryScriptHint + " and repeat the call with exactly that file content as `workflowScript`. Do **not** hand-edit, re-quote, or fix the script text yourself — if the retry also fails, stop and notify the user. Do not retry any reviewer that already started and failed.",
	);
	blocks.push("- **Do not** call `subagent` for verification, re-review, or rewriting the report.");
	blocks.push(
		"- **Never read `.pi-subagents/` (artifacts, transcripts, run metadata) or reconstruct findings from disk.** Findings for `pi_review_report` come exclusively from the workflow return value of the Step 2 call — files left there by earlier runs describe OTHER reviews (a real incident had a failed workflow followed by stale-artifact findings presented as the current PR's).",
	);
	blocks.push(
		"- Use the exact `pi-review.*` agents below — do not substitute builtin `reviewer`. Keep per-child `toolBudget` / `turnBudget` and the top-level `async:false` / `context:\"fresh\"` / `timeoutMs`.",
	);
	blocks.push("- Reviewer models **inherit** the parent session (omit per-child `model` unless the reviewer config sets an explicit model).");
	blocks.push(
		"- The `workflowScript` value below is a **template literal (backticks)** whose content is the exact text of the run's `workflow.js`. Copy its content verbatim — every character matters (paths, `outputSchema` JSON, budgets are already generated). Do not re-format, re-indent, unescape, or shorten it; the backtick form is unescaped by design so a straight copy is a valid script.",
	);
	blocks.push("");
	blocks.push(`**Skip these false positives:** ${FALSE_POSITIVE_GUIDANCE}.`);
	blocks.push("");

	blocks.push(
		"First, post the workflow as a markdown checklist into chat, then work through it — flip each `- [ ]` to `- [x]` as you finish.",
	);
	blocks.push("");
	const todoSteps = [
		`Confirm the plugin-prepared manifest is readable: ${manifestPath}`,
		`Confirm the target workspace is readable: ${workspacePath}`,
		lite
			? "Run one workflowScript: the lite-reviewer (one subagent call)"
			: gateOn
				? `Run one workflowScript: ${reviewers.length} parallel reviewers + inline gate (one subagent call)`
				: `Run one workflowScript: ${reviewers.length} parallel reviewers, no gate (one subagent call)`,
		"Call `pi_review_report` once with the workflow return value (never re-parse findings)",
	];
	for (const s of todoSteps) blocks.push(`- [ ] ${s}`);
	blocks.push("");

	// Step 1 — confirm the plugin-prepared manifest (no LLM-obtained diff).
	blocks.push("## Step 1 — Confirm the plugin-prepared run (you, the main agent)");
	blocks.push("");
	blocks.push(
		`The extension has **already** cloned/checked out the target repo, fetched an accurate diff, computed SHA-256 of the diff, and written \`${manifestPath}\` plus \`${diffPath}\`.`,
	);
	blocks.push("");
	blocks.push("Verify with a single `bash` call with **no `&&` / `||` chains** and no network calls. Use one `test` per file (no compound operators):");
	blocks.push("");
	blocks.push("```bash");
	blocks.push(`test -s ${JSON.stringify(diffPath)}`);
	blocks.push(`test -f ${JSON.stringify(manifestPath)}`);
	blocks.push(`test -d ${JSON.stringify(workspacePath)}`);
	blocks.push("```");
	blocks.push("");
	blocks.push("If any check fails, stop and notify the user. Otherwise continue.");
	blocks.push("");

	// Step 2 — single workflowScript call.
	const script = buildWorkflowScript({
		reviewers,
		gateModelWithThinking,
		gateThinking,
		gateModel,
		budgets,
		lite,
		gateEnabled: gateOn,
		threshold,
		verdictPolicy: policy,
		targetLabel: target.label,
		userContext: target.userContext,
		workspacePath,
		manifestPath,
		diffPath,
	});

	// Parse guard (P0 regression): make sure the generated script is valid JS
	// BEFORE it reaches the main agent. If the template ever regresses — or,
	// critically, if it ever grows a backtick or `${` (which would break the
	// template-literal presentation the main agent copies) — fail here instead
	// of at subagent() time.
	if (/[`$]/.test(script)) {
		throw new Error(
			"pi-review: generated workflowScript contains a backtick or `$` (template-literal conflict) — the directive presents it inside backticks, so this would corrupt the main agent's copy. This is a plugin bug; please report it.",
		);
	}
	try {
		new Function(`return (async () => {\n${script}\n})`);
	} catch (err) {
		throw new Error(
			`pi-review: generated workflowScript is not valid JavaScript — refusing to hand it to the main agent. This is a plugin bug; please report it. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Persist the raw script text so the main agent has a zero-unescape
	// retry source (see ReviewDirectiveInput.workflowPath).
	if (workflowPath) {
		try {
			writeFileSync(workflowPath, script, "utf-8");
		} catch {
			// Directive still works from the template literal below.
		}
	}

	blocks.push("## Step 2 — Run the review (exactly one subagent workflowScript call)");
	blocks.push("");
	blocks.push(
		lite
			? "The script fans out the single lite-reviewer, which returns a Markdown report ending in a fenced JSON block."
			: gateOn
				? "The script fans out the lean reviewers in parallel (Markdown reports), then feeds their reports to the gate, which returns a Markdown synthesis ending in a fenced JSON verdict block."
				: "The script fans out the lean reviewers in parallel (gate disabled in config); each returns a Markdown report.",
	);
	blocks.push("");
	blocks.push("```js");
	blocks.push("subagent({");
	blocks.push("  workflowScript: `");
	// The raw script, verbatim (no escaping). The script contains no
	// backticks and no ${, so the template literal is lossless.
	blocks.push(script);
	blocks.push("`,");
	blocks.push(`  async: false,`);
	blocks.push(`  context: "fresh",`);
	blocks.push(`  timeoutMs: ${budgets.timeoutMs},`);
	blocks.push(`  chatProgress: "auto",`);
	blocks.push("})");
	blocks.push("```");
	blocks.push("");
	blocks.push(
		`Copy the SUBAGENT CALL above verbatim (the workflowScript template-literal content is the exact text of \`${workflowPath ?? "workflow.js"}\`). If the call is rejected with a script parse error, \`Read\` the workflow.js file and repeat the call with that content — one retry only, no hand-editing.`,
	);
	blocks.push("");

	// Step 3 — tool call.
	blocks.push("## Step 3 — Render the report (call `pi_review_report`)");
	blocks.push("");
	blocks.push(
		"Call the `pi_review_report` tool **exactly once** with `{ runId, workflowReturn }`. The tool loads the manifest, extracts + validates the gate's fenced JSON verdict block, runs the deterministic verdict rules, and renders the final markdown + persists a session entry. Do not re-write findings yourself.",
	);
	blocks.push("");

	// Parse guard (P0 regression): make sure the generated script is valid JS
	// BEFORE it reaches the main agent. If the template ever regresses (e.g. an
	// unquoted path), fail here with a clear error instead of at subagent() time.
	try {
		new Function(`return (async () => {\n${script}\n})`);
	} catch (err) {
		throw new Error(
			`pi-review: generated workflowScript is not valid JavaScript — refusing to hand it to the main agent. This is a plugin bug; please report it. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return blocks.join("\n");
}

/**
 * Build the inline workflowScript string. Single-wave: one `runs.all([...])`
 * for reviewers, one `runs.run(\"gate\")`. Every child carries `cwd`,
 * `outputSchema`, `toolBudget`/`turnBudget`; explicit model overrides flow
 * through only when the reviewer config is not `inherit`.
 */
export function buildWorkflowScript(input: {
	reviewers: ReviewerSpec[];
	gateModelWithThinking: string;
	/** Raw gate thinking level (fallback branch passes it as a child param). */
	gateThinking?: string;
	gateModel: string;
	budgets: LeanBudgetSpec;
	lite: boolean;
	/** Mirror of the directive-level gate switch (false when lite OR disabled). */
	gateEnabled?: boolean;
	threshold: number;
	/** Verdict policy for the gate task text (strict is code-side default). */
	verdictPolicy?: "strict" | "legacy";
	targetLabel: string;
	userContext?: string;
	/** Absolute target workspace path (reviewer + gate cwd). */
	workspacePath: string;
	/** Absolute run manifest path. */
	manifestPath: string;
	/** Absolute change.diff path. */
	diffPath: string;
}): string {
	const {
		reviewers,
		gateModelWithThinking,
		gateThinking,
		gateModel,
		budgets,
		lite,
		gateEnabled = true,
		threshold,
		verdictPolicy = "strict",
		targetLabel,
		userContext,
		workspacePath,
		manifestPath,
		diffPath,
	} = input;
	const gateOn = !lite && gateEnabled;

	// Blanket read-only declaration. pi-subagents classifies each task text for
	// mutation intent: with a generic-object prohibition ("do not write any
	// files") plus "review only"/"return findings only", the task is
	// unambiguously read-only, so a read-only agent (gate: tools read) is never
	// rejected by the implementation-tool contract, and acceptance stays at the
	// lightweight attested level instead of "risky write-capable".
	const READ_ONLY_PREFIX =
		"READ-ONLY task — review only. Do not write any files. Do not edit files. Return findings only.";

	const lines: string[] = [];
	// v0.8: no outputSchema on any child — the structured-output tool
	// contract was too fragile in the field ("Missing structured_output
	// call" after budget wrap-ups). Reviewers return Markdown reports; the
	// gate ends with a fenced JSON verdict block that the report tool
	// extracts. See agents/*.md "Output format" sections.
	lines.push("");
	// Bind the reviewer array to a local FIRST: the gate IIFE and
	// `reviewersShaped` below both reference `reviewers`, and a bare object
	// property (`return { reviewers: ... }`) does NOT create a variable
	// binding — that produced `ReferenceError: reviewers is not defined` at
	// runtime (silently surfaced as a null workflow return).
	lines.push("const reviewers = await runs.all([");
	for (const r of reviewers) {
		const tb = LEAN_BUDGETS.defaultToolBudget; // resolved below per-id
		const tbForId = r.id === "history-context" ? LEAN_BUDGETS.historyToolBudget : tb;
		const taskParts = [
			READ_ONLY_PREFIX,
			`Read ${JSON.stringify(diffPath)} as the change — the diff is the authoritative change record; workspace files are context only. When a workspace file disagrees with the diff, trust the diff and note the discrepancy in coverage.limitations.`,
			`Also read ${JSON.stringify(manifestPath)} for change-profile (docsOnly, file list, rule file paths). Do not re-fetch via gh/git.`,
			`Your cwd is the target workspace (${JSON.stringify(workspacePath)}). Run all read/grep/git from there.`,
			"Stay within budgets; finish with your Markdown report (Summary / Findings / Coverage) as your final message and stop.",
			"Do not read plan.md, progress.md, anything under .pi-subagents/ (artifacts and transcripts included), or node_modules.",
			"Prefer Read/Grep. If you use bash, only simple allowlisted commands (no &&/||/; compounds).",
		];
		if (r.id === "claude-md-compliance") {
			taskParts.push(
				`If change-profile.rulePaths is empty, return status: skipped with empty issues — do not invent rule violations.`,
			);
		}
		if (r.id === "history-context") {
			taskParts.push(
				`If change-profile.history.available is false, return status: skipped with empty issues. Take ≤5 paths from the file list and run ONE bash: git log -n 5 --oneline -- <file1> <file2> ...`,
			);
		}
		if (r.id === "code-comments") {
			taskParts.push(
				`If change-profile.docsOnly is true, return status: skipped with empty issues.`,
			);
		}
		if (r.id === "bugbot" || r.id === "security-review") {
			taskParts.push(
				`If change-profile.docsOnly is true, return status: skipped with empty issues. Otherwise prefer diff-only; at most 3 extra file reads.`,
			);
		}
		if (userContext?.trim()) {
			taskParts.push(`User request: ${userContext.trim()}`);
		}

		const modelClause =
			r.model && r.model !== "inherit"
				? `\n      model: ${JSON.stringify(r.model)},`
				: "";
		lines.push("    {");
		lines.push(`      key: ${JSON.stringify(r.id)},`);
		lines.push(`      agent: ${JSON.stringify(leanAgentName(r.id))},`);
		// Task as an array joined at runtime — one short quoted line per
		// instruction. A single JSON.stringify of the whole task produced
		// 900+ char lines, the other fragile copy point.
		lines.push(`      task: [`);
		for (const part of taskParts) {
			lines.push(`        ${JSON.stringify(part)},`);
		}
		lines.push(`      ].join(" "),`);
		lines.push(`      cwd: ${JSON.stringify(workspacePath)},`);
		if (r.thinking) {
			lines.push(`      thinking: ${JSON.stringify(r.thinking)},`);
		}
		lines.push(`      toolBudget: { soft: ${tbForId.soft}, hard: ${tbForId.hard} },`);
		lines.push(
			`      turnBudget: { maxTurns: ${budgets.turnBudget.maxTurns}, graceTurns: ${budgets.turnBudget.graceTurns} },${modelClause}`,
		);
		lines.push("    },");
	}
	lines.push("]);");
	lines.push("");

	// ---- gate ----------------------------------------------------------
	// Top-level statements ONLY: pi-subagents' workflowScript AST walker
	// rejects nested async functions ("Use top-level await, plain helper
	// functions, or explicit Promise chains"). The pre-0.7.4 form
	// `gate: await (async () => { ... })()` therefore never passed upstream
	// validation — every prior failure that survived the copy stage died
	// here (2026-08-26 session: "validation failed before child launch").
	if (gateOn) {
		const gateTaskParts = [
			READ_ONLY_PREFIX,
			`Synthesize reviewer findings for ${targetLabel}.`,
			`The full diff is at ${JSON.stringify(diffPath)} and your cwd is the target workspace — you CAN and SHOULD verify candidates yourself.`,
			`Threshold ${threshold}: drop candidates with finalConfidence < ${threshold}.`,
			`Inputs are the reviewers' Markdown reports (## Summary / ## Findings / ## Coverage sections, one per reviewer).`,
			`Re-score every candidate 1–10. For each blocker/major candidate, first try to verify it by reading the diff hunk and the touched file in the workspace; state what you checked in the disposition reason.`,
			`Never raise a candidate above 8 without your own verification evidence from the diff or workspace files.`,
			`If you cannot verify a blocker/major candidate (missing context, truncated diff), do NOT silently drop it: keep it at the reviewer's original confidence, prefix the reason with "unverified:", and let the human decide — the parent's report tool floors unverified blocker/major candidates at the threshold so they stay visible.`,
			`Every candidate must appear in dispositions with decision (kept | dropped | merged), originalConfidence, finalConfidence, sourceReviewers, reason.`,
			verdictPolicy === "legacy"
				? `Verdict (legacy): request_changes if any blocker OR >=3 majors; approve if no blocker/major; else comment.`
				: `Verdict (strict): request_changes if any surviving blocker or major; comment if only minor/nit; approve if no surviving issues.`,
			`The parent re-applies verdict in code; this is a recommendation.`,
			`Skip false positives: ${FALSE_POSITIVE_GUIDANCE}.`,
			`End your report with exactly one fenced json block containing { status, verdict, issues[], dispositions[], reason } — the parent machine-reads that block.`,
		];

		// Inline the reviewers' Markdown reports for the gate to arbitrate.
		// (Sync arrow — allowed; only async functions are rejected upstream.)
		lines.push("const reviewerSections = reviewers.map((r) => {");
		lines.push("  const head = '## Reviewer: ' + r.key + (r.ok ? '' : ' (FAILED: ' + String(r.error || 'run failed').slice(0, 120) + ')');");
		lines.push("  return head + '\\n\\n' + String(r.output || '(no output)').slice(0, 6000);");
		lines.push("});");
		// Gate task as an array join (short lines) — same copy-safety rule as
		// the reviewer tasks above.
		lines.push("const gateTask = [");
		for (const part of gateTaskParts) {
			lines.push(`  ${JSON.stringify(part)},`);
		}
		lines.push(`].join(" ") + '\\n\\n# Reviewer reports (Markdown)\\n\\n' + reviewerSections.join('\\n\\n---\\n\\n');`);
		// Proxy providers often report bare model ids from the child ("MiniMax-M2.7")
		// that fail the launcher's strict model verification against the launch
		// candidate ("CPA/Minimax/MiniMax-M2.7:high") — observed 2026-08-27. The
		// reviewers never hit this (they inherit). So: try the configured model
		// first; on launch failure retry once with an inherited model under a
		// DIFFERENT key (the runtime rejects same-key launches with different
		// params). A second failure rejects as before.
		lines.push("let gateRun;");
		lines.push("try {");
		lines.push("  gateRun = await runs.run('gate', {");
		lines.push(`    agent: ${JSON.stringify(LEAN_GATE_AGENT)},`);
		lines.push("    task: gateTask,");
		lines.push(`    cwd: ${JSON.stringify(workspacePath)},`);
		lines.push(`    model: ${JSON.stringify(gateModelWithThinking)},`);
		lines.push(`    toolBudget: { soft: ${budgets.gateToolBudget.soft}, hard: ${budgets.gateToolBudget.hard} },`);
		lines.push(`    turnBudget: { maxTurns: ${budgets.gateTurnBudget.maxTurns}, graceTurns: ${budgets.gateTurnBudget.graceTurns} },`);
		lines.push("  });");
		lines.push("} catch (gateLaunchError) {");
		lines.push("  gateRun = await runs.run('gate-fallback', {");
		lines.push(`    agent: ${JSON.stringify(LEAN_GATE_AGENT)},`);
		lines.push("    task: gateTask,");
		lines.push(`    cwd: ${JSON.stringify(workspacePath)},`);
		if (gateThinking && gateThinking !== "off" && gateThinking !== "false") {
			lines.push(`    thinking: ${JSON.stringify(gateThinking)},`);
		}
		lines.push(`    toolBudget: { soft: ${budgets.gateToolBudget.soft}, hard: ${budgets.gateToolBudget.hard} },`);
		lines.push(`    turnBudget: { maxTurns: ${budgets.gateTurnBudget.maxTurns}, graceTurns: ${budgets.gateTurnBudget.graceTurns} },`);
		lines.push("  });");
		lines.push("}");
		lines.push("const gate = {");
		lines.push("  ok: gateRun.ok,");
		lines.push("  error: gateRun.error,");
		lines.push("  output: gateRun.output,");
		
		lines.push("};");
		lines.push("");
	}

	lines.push("return {");
	lines.push("  reviewers,");
	if (gateOn) {
		lines.push("  gate,");
	} else {
		lines.push("  gate: null,");
	}

	// ---- reviewer summary shape ----------------------------------------
	lines.push("  reviewersShaped: reviewers.map((r) => ({");
	lines.push("    key: r.key,");
	lines.push("    ok: r.ok,");
	lines.push("    error: r.error,");
	lines.push("    output: r.output,");
	lines.push("  })),");
	lines.push("};");
	return lines.join("\n");
}

/** Map the workflow return value into a normalized `ReviewWorkflowReturn` for the tool. */
export function buildWorkflowReturnShape() {
	return "{ reviewers, reviewersShaped, gate }";
}

// `gateModel` reserved for config validation parity with previous surface.
export const _LEGACY_PARITY = { gateModel: "" };
void _LEGACY_PARITY;