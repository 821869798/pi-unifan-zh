import type {
	GateDisposition,
	GateRunResult,
	Issue,
	IssueSeverity,
	ReviewReport,
	ReviewerRunResult,
	Verdict,
} from "./types.js";

const EMPTY_SEVERITY: Record<IssueSeverity, number> = {
	blocker: 0,
	major: 0,
	minor: 0,
	nit: 0,
};

export interface ReviewerWorkflowResult {
	key: string;
	ok: boolean;
	error?: string;
	output?: string;
	structuredOutput?: unknown;
}

export interface WorkflowReturnValue {
	reviewers?: ReviewerWorkflowResult[];
	gate?: { ok: boolean; error?: string; output?: string; structuredOutput?: unknown } | null;
}

export function coerceReviewerOutput(r: ReviewerWorkflowResult): {
	status: "ok" | "limited" | "skipped" | "failed";
	issues: Issue[];
	summary: string;
	coverage: { filesChecked: string[]; commandsRun: string[]; limitations: string[] };
} {
	if (!r.ok) {
		return {
			status: "failed",
			issues: [],
			summary: r.error ?? "审查专家执行失败",
			coverage: { filesChecked: [], commandsRun: [], limitations: [r.error ?? "审查专家执行失败"] },
		};
	}
	const md = r.output ?? "";
	const skipped = /^\s*##\s*Summary\s*\n+\s*SKIPPED:/im.test(md) || /^\s*SKIPPED:/m.test(md);
	return {
		status: skipped ? "skipped" : "ok",
		issues: [],
		summary: md,
		coverage: { filesChecked: [], commandsRun: [], limitations: [] },
	};
}

export function coerceGateOutput(gate: WorkflowReturnValue["gate"]): {
	status: "ok" | "limited" | "skipped" | "failed";
	verdict?: Verdict;
	issues: Issue[];
	dispositions: GateDisposition[];
	reason: string;
} {
	if (!gate || !gate.ok) {
		return {
			status: "failed",
			issues: [],
			dispositions: [],
			reason: gate?.error ?? "门禁裁判执行失败",
		};
	}
	const so = gate.structuredOutput;
	if (!so || typeof so !== "object") {
		return {
			status: "limited",
			issues: [],
			dispositions: [],
			reason: "门禁裁判未返回结构化输出",
		};
	}
	const obj = so as {
		status?: string;
		verdict?: Verdict;
		issues?: Issue[];
		dispositions?: GateDisposition[];
		reason?: string;
	};
	return {
		status: obj.status === "ok" || obj.status === "limited" || obj.status === "skipped" ? obj.status : "ok",
		verdict: obj.verdict,
		issues: Array.isArray(obj.issues) ? obj.issues : [],
		dispositions: Array.isArray(obj.dispositions) ? obj.dispositions : [],
		reason: typeof obj.reason === "string" ? obj.reason : "",
	};
}

export function reviewerRow(
	id: string,
	label: string,
	res: ReviewerWorkflowResult,
	durationMs: number,
): ReviewerRunResult {
	const coerced = coerceReviewerOutput(res);
	return {
		id,
		label,
		model: "(见工作流配置)",
		ok: res.ok,
		output: {
			status: coerced.status,
			issues: coerced.issues,
			summary: coerced.summary,
			coverage: coerced.coverage,
		},
		error: res.error,
		durationMs,
	};
}

export function computeTotals(issues: Issue[]): {
	issues: number;
	bySeverity: Record<IssueSeverity, number>;
} {
	const bySeverity = { ...EMPTY_SEVERITY };
	for (const i of issues) bySeverity[i.severity]++;
	return { issues: issues.length, bySeverity };
}

export function reportVerdict(
	reviewers: ReviewerWorkflowResult[],
	gate: { ok: boolean; structuredOutput?: unknown; error?: string } | null | undefined,
	enforcedVerdict?: Verdict,
): Verdict | "no-gate" | "error" | "partial" {
	if (reviewers.length > 0 && reviewers.every((r) => coerceReviewerOutput(r).status === "failed")) return "error";
	if (!gate || !gate.ok) return "no-gate";
	const so = gate.structuredOutput as { status?: string } | null;
	if (so?.status && so.status !== "ok") return "partial";
	if (reviewers.length > 0 && reviewers.every((r) => coerceReviewerOutput(r).status === "skipped")) {
		return enforcedVerdict === "approve" ? "comment" : enforcedVerdict ?? "comment";
	}
	return enforcedVerdict ?? "comment";
}

export type ReportVerdictKind = Verdict | "no-gate" | "error" | "partial";

export interface ReportInput {
	startedAt: number;
	manifest: {
		runId: string;
		targetLabel: string;
		targetKind: string;
		prRef?: string;
		diffSha256: string;
		workspacePath: string;
		workspaceHeadSha?: string;
		workspaceWarning?: string;
		diffWarning?: string;
		mode?: string;
		docsOnly: boolean;
		rulePaths: string[];
		historyAvailable: boolean;
		changedFiles: string[];
		baseSha?: string;
		headSha?: string;
		skippedReviewers?: Array<{ id: string; reason: string }>;
	};
	workflowReturn: WorkflowReturnValue;
	threshold: number;
	policy: "strict" | "legacy";
	enforcedVerdict: Verdict;
	enforcedIssues: Issue[];
	enforcedDispositions: GateDisposition[];
	enforcedReason: string;
}

export interface BuiltReport extends Omit<ReviewReport, "verdict"> {
	manifest: ReportInput["manifest"];
	dispositions: GateDisposition[];
	reviewerStatus: Array<{ id: string; status: string; limitations: string[] }>;
	gateStatus: "ok" | "limited" | "skipped" | "failed";
	verdict: Verdict | "no-gate" | "error" | "partial";
}

export function buildReportFromWorkflow(input: ReportInput): BuiltReport {
	const durationMs = Date.now() - input.startedAt;
	const reviewerResults = (input.workflowReturn.reviewers ?? []).map((r) =>
		reviewerRow(r.key, r.key, r, 0),
	);
	const reviewerStatus = (input.workflowReturn.reviewers ?? []).map((r) => {
		const c = coerceReviewerOutput(r);
		return { id: r.key, status: c.status, limitations: c.coverage.limitations };
	});
	const gateRaw = input.workflowReturn.gate ?? null;
	const coercedGate = coerceGateOutput(gateRaw);
	const gateResult: GateRunResult = {
		ok: !!gateRaw?.ok,
		verdict: {
			verdict: input.enforcedVerdict,
			issues: input.enforcedIssues,
			dispositions: input.enforcedDispositions,
			status: coercedGate.status,
			reason: input.enforcedReason,
		},
		error: gateRaw?.error,
		durationMs: 0,
		model: "(见工作流配置)",
	};
	const totals = computeTotals(input.enforcedIssues);
	const verdict = reportVerdict(input.workflowReturn.reviewers ?? [], gateRaw, input.enforcedVerdict);

	return {
		startedAt: input.startedAt,
		durationMs,
		input: {
			kind: input.manifest.targetKind as ReviewReport["input"]["kind"],
			label: input.manifest.targetLabel,
			prRef: input.manifest.prRef,
		},
		reviewers: reviewerResults,
		gate: gateResult,
		totals,
		verdict,
		manifest: input.manifest,
		dispositions: input.enforcedDispositions,
		reviewerStatus,
		gateStatus: coercedGate.status,
	};
}

export function renderReport(report: BuiltReport): string {
	const lines: string[] = [];
	lines.push(`## 🔍 AI 代码审查报告 — ${report.input.label}`);
	lines.push("");
	lines.push(renderVerdictLine(report));
	lines.push(renderSummaryLine(report));
	lines.push("");
	lines.push(renderRunLine(report));
	if (report.manifest.prRef) {
		lines.push(`- PR: ${report.manifest.prRef}`);
	}
	if (report.manifest.mode) {
		lines.push(`- Diff 模式: ${report.manifest.mode}`);
	}
	if (report.manifest.baseSha && report.manifest.headSha) {
		lines.push(`- 基础版本 Base: ${report.manifest.baseSha.slice(0, 12)} · 目标版本 Head: ${report.manifest.headSha.slice(0, 12)}`);
	}
	if (report.manifest.workspaceHeadSha) {
		if (report.manifest.headSha) {
			const matched = report.manifest.workspaceHeadSha === report.manifest.headSha;
			lines.push(
				`- 工作区 HEAD: ${report.manifest.workspaceHeadSha.slice(0, 12)}${matched ? " (与 Diff HEAD 匹配)" : " (与 Diff HEAD 不一致)"}`,
			);
		} else {
			lines.push(`- 工作区 HEAD: ${report.manifest.workspaceHeadSha.slice(0, 12)}`);
		}
	}
	if (report.manifest.workspaceWarning) {
		lines.push(`- 工作区提示: ${report.manifest.workspaceWarning}`);
	}
	if (report.manifest.diffWarning) {
		lines.push(`- Diff 提示: ${report.manifest.diffWarning}`);
	}
	lines.push(`- Diff 哈希: ${report.manifest.diffSha256.slice(0, 16)}…`);
	lines.push(`- 工作区路径: ${report.manifest.workspacePath}`);
	lines.push(`- Git 历史可用: ${report.manifest.historyAvailable ? "是" : "否"}`);
	lines.push(`- 纯文档变更: ${report.manifest.docsOnly ? "是" : "否"}`);
	if (report.manifest.rulePaths.length > 0) {
		lines.push(`- 项目规范文件: ${report.manifest.rulePaths.join(", ")}`);
	} else {
		lines.push(`- 项目规范文件: (无)`);
	}
	lines.push("");

	if (report.manifest.skippedReviewers && report.manifest.skippedReviewers.length > 0) {
		lines.push("### ⚡ 自适应跳过的专家");
		for (const s of report.manifest.skippedReviewers) {
			lines.push(`- ${s.id}: ${s.reason}`);
		}
		lines.push("");
	}

	if (report.reviewerStatus.length > 0) {
		lines.push("### 📊 专家审查覆盖率");
		for (const s of report.reviewerStatus) {
			const limit = s.limitations.length > 0 ? ` (${s.limitations.join("; ")})` : "";
			lines.push(`- ${s.id}: ${s.status}${limit}`);
		}
		lines.push("");
	}

	if (report.reviewers.length > 0) {
		lines.push("### 🕵️ 专家详细发现");
		for (const r of report.reviewers) {
			lines.push(renderReviewerSection(r));
		}
	}

	if (report.gate) {
		lines.push(renderGateSection(report.gate));
	}

	if (report.dispositions.length > 0) {
		lines.push(renderDispositions(report.dispositions));
	}

	return lines.join("\n");
}

function renderVerdictLine(report: BuiltReport): string {
	const v = report.verdict;
	const label =
		v === "no-gate"
			? "NO GATE (无门禁)"
			: v === "error"
				? "ERROR (异常)"
				: v === "partial"
					? "PARTIAL (部分完成)"
					: v === "approve"
						? "APPROVE (审核通过)"
						: v === "request_changes"
							? "REQUEST_CHANGES (需要修改)"
							: "COMMENT (普通建议)";
	const t = report.totals.bySeverity;
	return `**审查裁决: ${label}** (${t.blocker} 致命阻断 · ${t.major} 严重 · ${t.minor} 次要 · ${t.nit} 细节优化)`;
}

function renderSummaryLine(report: BuiltReport): string {
	const dur = (report.durationMs / 1000).toFixed(1);
	const reviewerCount = report.reviewers.length;
	const gateCount = report.gate ? 1 : 0;
	return `审查耗时 ${dur}s · ${reviewerCount} 个审查专家 · ${gateCount} 个门禁裁判`;
}

function renderRunLine(report: BuiltReport): string {
	return `- 审查编号: ${report.manifest.runId}`;
}

export function renderReviewerSection(r: ReviewerRunResult): string {
	const status = r.ok ? "已完成" : "失败";
	const dur = (r.durationMs / 1000).toFixed(1);
	const head = `#### ${r.id} — ${status} · 耗时 ${dur}s`;
	if (!r.ok) {
		return [head, "", `- ${r.error ?? "未知错误"}`, ""].join("\n");
	}
	const md = r.output?.summary ?? "";
	const body: string[] = [head, ""];
	if (md.trim()) {
		body.push(md.trim());
	} else {
		body.push("- (无输出内容)");
	}
	body.push("");
	return body.join("\n");
}

function renderGateSection(g: GateRunResult): string {
	if (!g.ok) {
		return [`### ⚖️ 门禁裁判长 (Gate) — 执行失败`, "", `- ${g.error ?? "未知错误"}`, ""].join("\n");
	}
	const v = g.verdict;
	if (!v) {
		return [`### ⚖️ 门禁裁判长 (Gate) — 完成 · 未产生裁决`, ""].join("\n");
	}
	const issues = v.issues;
	return [
		`### ⚖️ 门禁裁判长 (Gate) 综合裁决 · 耗时 ${(g.durationMs / 1000).toFixed(1)}s`,
		"",
		`- 最终裁决: ${v.verdict}`,
		`- 裁决理由: ${v.reason}`,
		`- 去重与置信度过滤后共计: ${issues.length} 个关键问题`,
		"",
	]
		.concat(
			issues.map((issue) => {
				const loc = issue.line !== undefined ? `${issue.file}:${issue.line}` : issue.file;
				return `- [${issue.severity.toUpperCase()} · ${issue.category} · 置信度 ${issue.confidence}] \`${loc}\` — ${issue.evidence}`;
			}),
		)
		.concat([""])
		.join("\n");
}

function renderDispositions(dispositions: GateDisposition[]): string {
	const lines: string[] = ["### 🎯 高严重级别问题判定清单", ""];
	const sorted = [...dispositions].sort((a, b) => {
		if (a.decision === b.decision) return b.originalConfidence - a.originalConfidence;
		const order = { dropped: 0, merged: 1, kept: 2 } as const;
		return order[a.decision] - order[b.decision];
	});
	for (const d of sorted.slice(0, 25)) {
		const action = d.decision === "kept" ? "保留" : d.decision === "merged" ? "合并" : "过滤/丢弃";
		lines.push(
			`- ${action} \`${d.fingerprint}\` · 置信度 ${d.originalConfidence}→${d.finalConfidence} · ${d.reason}`,
		);
	}
	if (dispositions.length > 25) {
		lines.push(`- … 另有 ${dispositions.length - 25} 条判定记录`);
	}
	lines.push("");
	return lines.join("\n");
}