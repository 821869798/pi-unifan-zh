import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { IssueSeverity, Verdict } from "./types.js";

interface SeverityTotals {
	blocker: number;
	major: number;
	minor: number;
	nit: number;
}

interface ReportHeader {
	verdict: Verdict | "no-gate" | "error" | "partial";
	totals?: SeverityTotals;
}

function extractHeader(markdown: string): ReportHeader {
	const m = markdown.match(/(?:Verdict|审查裁决):\s*([A-Za-z_\u4e00-\u9fa5]+)\s*(?:（[^)]*）|\([^)]*\))?\s*\*{0,2}\s*\(([^)]*)\)/);
	if (!m) return { verdict: "comment" };
	const raw = m[1]?.toLowerCase();
	let verdict: ReportHeader["verdict"] = "comment";
	if (raw?.includes("approve") || raw?.includes("通过")) verdict = "approve";
	else if (raw?.includes("request_changes") || raw?.includes("需要修改")) verdict = "request_changes";
	else if (raw?.includes("no-gate") || raw?.includes("无门禁")) verdict = "no-gate";
	else if (raw?.includes("error") || raw?.includes("异常")) verdict = "error";
	else if (raw?.includes("partial") || raw?.includes("部分")) verdict = "partial";
	else verdict = "comment";

	const counts = (m[2] ?? "").match(/(\d+)\s*(?:blocker|致命阻断)\s*[·•]\s*(\d+)\s*(?:major|严重)\s*[·•]\s*(\d+)\s*(?:minor|次要)\s*[·•]\s*(\d+)\s*(?:nit|细节优化)/);
	const totals: SeverityTotals | undefined = counts
		? {
				blocker: Number(counts[1] ?? 0),
				major: Number(counts[2] ?? 0),
				minor: Number(counts[3] ?? 0),
				nit: Number(counts[4] ?? 0),
			}
		: undefined;
	return { verdict, totals };
}

function displayVerdict(v: ReportHeader["verdict"]): string {
	switch (v) {
		case "approve":
			return "审核通过 (Approve)";
		case "request_changes":
			return "需要修改 (Request Changes)";
		case "comment":
			return "普通建议 (Comment)";
		case "no-gate":
			return "无门禁 (No Gate)";
		case "error":
			return "审查异常 (Error)";
		case "partial":
			return "部分完成 (Partial)";
	}
}

export function summaryLine(header: ReportHeader): string {
	const t = header.totals;
	const counts = t
		? ` · ${t.blocker} 致命阻断 · ${t.major} 严重 · ${t.minor} 次要 · ${t.nit} 细节优化`
		: "";
	return `pi-review 代码审查裁决: ${displayVerdict(header.verdict)}${counts}`;
}

export function registerPiReviewRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("pi-review", (message, _options, theme) => {
		const contentText = typeof message.content === "string"
			? message.content
			: (() => {
					const parts: string[] = [];
					for (const block of message.content) {
						if (block.type === "text") parts.push(block.text);
					}
					return parts.join("\n");
				})();
		if (contentText.startsWith("/review")) {
			const echo = theme.fg("toolTitle", "[pi-review] ") + contentText;
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(echo, 0, 0));
			return box;
		}
		const header = extractHeader(contentText);
		const summary = theme.bold(theme.fg("toolTitle", summaryLine(header)));
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(summary, 0, 0));
		box.addChild(new Text("", 0, 0));
		box.addChild(new Text(contentText, 0, 0));
		return box;
	});
}