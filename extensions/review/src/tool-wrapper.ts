/**
 * Thin wrapper that adapts `runReportTool` to `pi.registerTool`. The tool
 * loads the manifest, validates the workflow return value's reviewer/gate
 * structuredOutput, runs the deterministic verdict + report builder, and
 * persists a session entry.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runReportTool } from "./report-tool.js";

export function registerReviewReportTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pi_review_report",
		label: "pi-review Report",
		description:
			"Finalize a pi-review run. Inputs: runId + the workflow return value from the reviewer's `runs.all`/`runs.run` call. Loads the manifest, enforces the verdict in code, and persists a session entry.",
		parameters: Type.Object({
			runId: Type.String({ description: "Run id from the prepared manifest (e.g. 'xyz123-abc')." }),
			workflowReturn: Type.Any({
				description: "The workflow return value `{ reviewers, gate }` from the most recent subagent() call.",
			}),
			threshold: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
			verdictPolicy: Type.Optional(Type.Union([
				Type.Literal("strict"),
				Type.Literal("legacy"),
			])),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = runReportTool({
				runId: params.runId,
				workflowReturn: params.workflowReturn,
				threshold: params.threshold,
				verdictPolicy: params.verdictPolicy,
				cwd: ctx.cwd,
			});
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `pi_review_report failed: ${result.error}` }],
					details: { error: result.error },
				};
			}
			// Persist a session entry so the TUI renderer can render a
			// collapsible card and `/review-show` can re-render later.
			try {
				pi.appendEntry("pi-review", {
					runId: result.runId,
					verdict: result.verdict,
					markdown: result.markdown,
					report: result.report,
					createdAt: Date.now(),
				});
			} catch {
				// appendEntry is best-effort; the agent still has the markdown.
			}
			// Also push the markdown into chat so the user sees the report.
			pi.sendMessage({
				customType: "pi-review",
				content: result.markdown,
				display: true,
			});
			void ctx;
			const t = result.report.totals.bySeverity;
			return {
				content: [
					{
						type: "text",
						text: `pi-review result: ${result.verdict} · ${t.blocker} blocker · ${t.major} major · ${t.minor} minor · ${t.nit} nit — full report rendered in the pi-review card below.`,
					},
				],
				details: { runId: result.runId, verdict: result.verdict, report: result.report },
			};
		},
	});
}
