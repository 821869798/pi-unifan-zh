/**
 * Build the review directive injected into the main agent.
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
	gateModel: string;
	gateThinking?: string;
	threshold: number;
	verdictPolicy?: "strict" | "legacy";
	lite: boolean;
	perf?: boolean;
	gateEnabled?: boolean;
	cwd: string;
	workspacePath: string;
	manifestPath: string;
	diffPath: string;
	workflowPath?: string;
	budgets?: LeanBudgetSpec;
}

export function buildReviewDirective(input: ReviewDirectiveInput): string {
	const { target, reviewers, gateModel, gateThinking, threshold, lite, perf, cwd, workspacePath, manifestPath, diffPath, workflowPath } = input;
	const isSingle = lite || Boolean(perf);
	const policy = input.verdictPolicy ?? "strict";
	const gateOn = !isSingle && input.gateEnabled !== false;
	const budgets = input.budgets ?? resolveLeanBudgets();
	const gateModelWithThinking = withThinkingSuffix(gateModel, gateThinking);
	const blocks: string[] = [];

	const modeLabel = perf ? " (性能与基准测试专属模式)" : lite ? " (极速单兵模式)" : "";

	blocks.push(`# 代码审查流程${modeLabel}`);
	blocks.push("");
	if (target.userContext?.trim()) {
		blocks.push(`**用户指令/侧重点:** ${target.userContext.trim()}`);
		blocks.push("");
	}
	blocks.push(
		`请对本次代码改动 (${target.label}) 进行审查。插件已准备好目标工作区、diff 文件及运行清单。你需要执行一次 workflowScript 启动 ${reviewers.length} 个审查专家${modeLabel}${gateOn ? " + 门禁裁判长" : ""}，随后调用 \`pi_review_report\` 工具完成报告渲染与归档。切勿在聊天中直接重复书写未加工的原始问题细节。`,
	);
	blocks.push("");
	blocks.push("## 硬性规则（严禁违反）");
	blocks.push("");
	blocks.push("- **语言要求**：所有思维链（Thinking）、推理分析过程、面向用户的输出（包括工作流待办清单、状态汇报、问题总结与回复）**必须 100% 全程使用纯正中文**，严禁使用英文思考或撰写英文回复。");
	blocks.push("- 在本次审查中**只能且必须调用一次** `subagent` 工具：即第 2 步的 workflowScript 调用。");
	blocks.push(
		isSingle
			? "- 第 2 步必须是**单次** `subagent({ workflowScript, async:false, ... })` 调用，通过 `runs.all([...])` 并发执行专家——严禁多次调用。"
			: gateOn
				? "- 第 2 步必须是**单次** `subagent({ workflowScript, async:false, ... })` 调用，通过 `runs.all([...])` 并发执行**所有**专家，并通过 `runs.run(\"gate\", ...)` 运行门禁裁判长——严禁每个专家单独调用一次，严禁串行多波次调用。"
				: "- 第 2 步必须是**单次** `subagent({ workflowScript, async:false, ... })` 调用，通过 `runs.all([...])` 并发执行**所有**专家——严禁多波次单独调用。",
	);
	blocks.push(
		"- **切勿重试失败的子代理**：若某个专家超时、耗尽额度或报错，`runs.all` 会自动收集错误；流程继续进行并在最终报告中标注失败即可。",
	);
	const retryScriptHint = workflowPath ? `使用 Read 工具读取 \`${workflowPath}\`` : "使用 Read 工具读取 workflow.js 文件";
	blocks.push(
		"- **脚本级解析错误例外**：若 `subagent` 因 `workflowScript` 语法解析失败而拒绝执行（无任何专家启动），允许重试**一次**：" + retryScriptHint + " 并以该文件内容作为 `workflowScript` 重试。切勿手动篡改脚本内容。",
	);
	blocks.push("- **严禁**调用 `subagent` 进行额外的事后验证或重写报告。");
	blocks.push(
		"- **严禁读取 `.pi-subagents/`（工件、对话日志）或尝试从磁盘拼凑审查发现。** `pi_review_report` 所需数据全部来自第 2 步 workflowScript 的返回值。",
	);
	blocks.push(
		"- 严格使用下方指定的 `pi-review.*` 代理名称，保持每个子代理的 `toolBudget` / `turnBudget` 与全局的 `async:false` / `context:\"fresh\"` / `timeoutMs`。",
	);
	blocks.push("- 审查专家模型**默认继承**父会话（除非配置显式指定了具体模型）。");
	blocks.push(
		"- 下方的 `workflowScript` 是一个模板字面量，已包含完整路径与参数。请一字不差地复制使用。",
	);
	blocks.push("");
	blocks.push(`**忽略以下误报内容:** ${FALSE_POSITIVE_GUIDANCE}。`);
	blocks.push("");

	blocks.push(
		"首先，在聊天中输出中文工作流待办清单（Checklist），随后逐步执行，并在完成每步后将 `- [ ]` 标记为 `- [x]`：",
	);
	blocks.push("");
	const todoSteps = [
		`确认插件准备的运行清单可读: ${manifestPath}`,
		`确认目标工作区可读: ${workspacePath}`,
		perf
			? "执行 workflowScript: 启动专项性能与基准测试审查专家 (单次 subagent 调用)"
			: lite
				? "执行 workflowScript: 启动单兵极速审查专家 (单次 subagent 调用)"
				: gateOn
					? `执行 workflowScript: 启动 ${reviewers.length} 个并发审查专家 + 门禁裁判长 (单次 subagent 调用)`
					: `执行 workflowScript: 启动 ${reviewers.length} 个并发审查专家 (单次 subagent 调用)`,
		"调用 `pi_review_report` 工具提交审查结果并生成中文报告",
	];
	for (const s of todoSteps) blocks.push(`- [ ] ${s}`);
	blocks.push("");

	// Step 1
	blocks.push("## 第 1 步 — 确认插件准备的环境（由主代理执行）");
	blocks.push("");
	blocks.push(
		`插件已经完成了目标仓库准备，提取了准确的 diff 并计算了 SHA-256 哈希，生成了 \`${manifestPath}\` 与 \`${diffPath}\`。`,
	);
	blocks.push("");
	blocks.push("请使用单次 `bash` 调用（不使用 `&&` / `||` 复合连接符）验证文件存在：");
	blocks.push("");
	blocks.push("```bash");
	blocks.push(`test -s ${JSON.stringify(diffPath)}`);
	blocks.push(`test -f ${JSON.stringify(manifestPath)}`);
	blocks.push(`test -d ${JSON.stringify(workspacePath)}`);
	blocks.push("```");
	blocks.push("");
	blocks.push("若任何检查失败，停止并通知用户；检查通过则继续执行第 2 步。");
	blocks.push("");

	// Step 2
	const script = buildWorkflowScript({
		reviewers,
		gateModelWithThinking,
		gateThinking,
		gateModel,
		budgets,
		lite: isSingle,
		gateEnabled: gateOn,
		threshold,
		verdictPolicy: policy,
		targetLabel: target.label,
		userContext: target.userContext,
		workspacePath,
		manifestPath,
		diffPath,
	});

	if (/[`$]/.test(script)) {
		throw new Error(
			"pi-review: generated workflowScript contains a backtick or `$` (template-literal conflict).",
		);
	}
	try {
		new Function(`return (async () => {\n${script}\n})`);
	} catch (err) {
		throw new Error(
			`pi-review: generated workflowScript is not valid JavaScript: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (workflowPath) {
		try {
			writeFileSync(workflowPath, script, "utf-8");
		} catch {
			/* ignore */
		}
	}

	blocks.push("## 第 2 步 — 执行代码审查（仅调用一次 subagent workflowScript）");
	blocks.push("");
	blocks.push(
		isSingle
			? "该脚本会启动审查专家，输出包含 JSON 块的 Markdown 报告。"
			: gateOn
				? "该脚本会并发启动各个审查专家，随后将报告汇总给门禁裁判长，裁判长输出裁决报告与 JSON 块。"
				: "该脚本会并发启动各个审查专家，输出 Markdown 报告。",
	);
	blocks.push("");
	blocks.push("```js");
	blocks.push("subagent({");
	blocks.push("  workflowScript: `");
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
		`一字不差地复制上方代码执行。若出现解析错误，请使用 \`Read\` 读取 \`${workflowPath ?? "workflow.js"}\` 内容并重试一次。`,
	);
	blocks.push("");

	// Step 3
	blocks.push("## 第 3 步 — 渲染审查报告（调用 `pi_review_report`）");
	blocks.push("");
	blocks.push(
		"以 `{ runId, workflowReturn }` 调用 `pi_review_report` 工具**仅一次**。该工具会自动加载清单、解析裁判长的 JSON 裁决、执行判定规则并输出最终的中文 Markdown 审查报告。切勿自己手动重写发现。",
	);
	blocks.push("");

	return blocks.join("\n");
}

export function buildWorkflowScript(input: {
	reviewers: ReviewerSpec[];
	gateModelWithThinking: string;
	gateThinking?: string;
	gateModel: string;
	budgets: LeanBudgetSpec;
	lite: boolean;
	gateEnabled?: boolean;
	threshold: number;
	verdictPolicy?: "strict" | "legacy";
	targetLabel: string;
	userContext?: string;
	workspacePath: string;
	manifestPath: string;
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

	const READ_ONLY_PREFIX =
		"【最高优先级语言指令】只读审查任务：所有思维链（Thinking）、推理过程、问题分析与输出报告必须 100% 使用纯正中文！严禁在思考或报告中输出任何英文！严禁修改源码文件。";

	const lines: string[] = [];
	lines.push("");
	lines.push("let reviewers;");
	lines.push("try {");
	lines.push("  reviewers = await runs.all([");
	for (const r of reviewers) {
		const tbForId = toolBudgetForReviewer(r.id);
		const turnsForId = r.id === "lite-review" ? { maxTurns: 4, graceTurns: 1 } : budgets.turnBudget;
		const taskParts = [
			READ_ONLY_PREFIX,
			`读取 ${JSON.stringify(diffPath)} 作为改动内容——diff 是权威的修改记录，工作区文件仅作上下文参考。若工作区文件与 diff 存在差异，以 diff 为准并在 coverage.limitations 中说明。所有问题描述必须使用中文。`,
			`同时读取 ${JSON.stringify(manifestPath)} 获取改动概要（文档变更状态、文件列表、规则文件路径）。禁止通过外部命令重复拉取。`,
			`你的当前工作区为目标工作区 (${JSON.stringify(workspacePath)})。在此目录下执行必要的 read/grep。`,
			"在额度内完成分析；最终回复必须输出格式规范的 Markdown 审查报告（包含纯中文 审查概述 / 缺陷清单 / 审查覆盖 章节）并停止。所有思考分析、问题描述、证据引用和总结必须 100% 使用纯正中文，严禁使用英文。",
			"严禁读取 plan.md, progress.md, 以及 .pi-subagents/ 目录下的任何文件或 node_modules。",
			"优先使用 Read/Grep。若使用 bash，仅限简单的单条命令（禁止 &&/||/; 等复合命令）。",
		];
		if (r.id === "lite-review") {
			taskParts.push(
				"极速模式要求：严格在 2~3 轮内完成！读取 diff 后若无需核验直接出报告；若需核验最多只读 1 个文件或单次 grep，下一轮立即输出最终报告并停止！",
			);
		}
		if (r.id === "claude-md-compliance") {
			taskParts.push(
				"若 change-profile.rulePaths 为空，返回跳过状态：SKIPPED: no-rules，不提出虚构的违规。",
			);
		}
		if (r.id === "history-context") {
			taskParts.push(
				"若 change-profile.history.available 为 false，返回跳过状态：SKIPPED: no-history。从文件列表中选取不超过5个路径，仅执行一次 bash: git log -n 5 --oneline -- 文件1 文件2 ...",
			);
		}
		if (r.id === "code-comments") {
			taskParts.push(
				"若 change-profile.docsOnly 为 true，返回跳过状态：SKIPPED: docs-only。",
			);
		}
		if (r.id === "bugbot" || r.id === "security-review") {
			taskParts.push(
				"若 change-profile.docsOnly 为 true，返回跳过状态：SKIPPED: docs-only。否则优先从 diff 本身分析，最多只读取 3 个额外上下文文件。",
			);
		}
		if (r.id === "perf-review") {
			taskParts.push(
				"重点排查循环内高频GC分配、算法复杂度、锁竞争、内存泄漏，并主动探测和执行工作区中的Benchmark基准测试。",
			);
		}
		if (userContext?.trim()) {
			taskParts.push(`用户需求: ${userContext.trim()}`);
		}

		const modelClause =
			r.model && r.model !== "inherit"
				? `\n      model: ${JSON.stringify(r.model)},`
				: "";
		lines.push("    {");
		lines.push(`      key: ${JSON.stringify(r.id)},`);
		lines.push(`      agent: ${JSON.stringify(leanAgentName(r.id))},`);
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
			`      turnBudget: { maxTurns: ${turnsForId.maxTurns}, graceTurns: ${turnsForId.graceTurns} },${modelClause}`,
		);
		lines.push("    },");
	}
	lines.push("  ]);");
	lines.push("} catch (firstErr) {");
	lines.push("  // 自动网络重试保护：若首次并发因网络波动超时，自动延迟800ms后重试一次");
	lines.push("  await new Promise((resolve) => setTimeout(resolve, 800));");
	lines.push("  reviewers = await runs.all([");
	for (const r of reviewers) {
		const tbForId = toolBudgetForReviewer(r.id);
		const turnsForId = r.id === "lite-review" ? { maxTurns: 4, graceTurns: 1 } : budgets.turnBudget;
		const taskParts = [
			READ_ONLY_PREFIX,
			`读取 ${JSON.stringify(diffPath)} 作为改动内容——diff 是权威的修改记录，工作区文件仅作上下文参考。所有问题描述必须使用中文。`,
			`你的当前工作区为目标工作区 (${JSON.stringify(workspacePath)})。在此目录下执行必要的 read/grep。`,
			"在额度内完成分析；最终回复必须输出格式规范的 Markdown 审查报告（包含纯中文 审查概述 / 缺陷清单 / 审查覆盖 章节）并停止。所有思考分析、问题描述、证据引用和总结必须 100% 使用纯正中文，严禁使用英文。",
		];
		if (r.id === "lite-review") {
			taskParts.push(
				"极速模式要求：严格在 2~3 轮内完成！读取 diff 后若无需核验直接出报告；若需核验最多只读 1 个文件或单次 grep，下一轮立即输出最终报告并停止！",
			);
		}
		const modelClause =
			r.model && r.model !== "inherit"
				? `\n      model: ${JSON.stringify(r.model)},`
				: "";
		lines.push("    {");
		lines.push(`      key: ${JSON.stringify(r.id)},`);
		lines.push(`      agent: ${JSON.stringify(leanAgentName(r.id))},`);
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
			`      turnBudget: { maxTurns: ${turnsForId.maxTurns}, graceTurns: ${turnsForId.graceTurns} },${modelClause}`,
		);
		lines.push("    },");
	}
	lines.push("  ]);");
	lines.push("}");
	lines.push("");

	// Gate
	if (gateOn) {
		const gateTaskParts = [
			READ_ONLY_PREFIX,
			`对 ${targetLabel} 的所有专家审查发现进行综合仲裁与去重。所有分析、裁决理由与总结必须使用纯正中文。`,
			`完整 diff 位于 ${JSON.stringify(diffPath)}，当前工作区为目标工作区——你可以且应当亲自核验候选问题。`,
			`置信度阈值 ${threshold}：过滤掉最终置信度小于 ${threshold} 的假警报与无意义建议。`,
			`输入为各专家的 Markdown 报告（每个专家包含 ## 审查概述 / ## 缺陷清单 / ## 审查覆盖）。`,
			`重新评估每个问题的置信度（1–10 分）。对每个 blocker（致命）或 major（严重）候选问题，首先通过阅读 diff 块和目标文件进行核验，并在 disposition 的 reason 中用中文说明核验结果。`,
			`若未经你自己核验证实，严禁将候选问题评分提升至 8 分以上。`,
			`若因缺少上下文或 diff 截断而无法核验某个 blocker/major 问题，切勿静默丢弃：保留原置信度并在 reason 前缀注明 "未核验:"，交由人工判断。`,
			`每个问题必须记录在 dispositions 中，包含 decision (kept | dropped | merged), originalConfidence, finalConfidence, sourceReviewers, reason（中文理由）。`,
			verdictPolicy === "legacy"
				? `裁决规则: 存在任何 blocker 或 >=3 个 major 则判定为 request_changes; 无 blocker/major 则 approve; 否则 comment。`
				: `裁决规则: 存在任何存活的 blocker 或 major 则判定为 request_changes; 仅有 minor/nit 则 comment; 无存活问题则 approve。`,
			`过滤假警报: ${FALSE_POSITIVE_GUIDANCE}。`,
			`在报告末尾必须输出且仅输出一个被 json 代码块包裹的裁决 JSON 对象 { status, verdict, issues[], dispositions[], reason }（reason 与 evidence 必须为中文）——上层工具将机器读取该 JSON。`,
		];

		lines.push("const reviewerSections = reviewers.map((r) => {");
		lines.push("  const head = '## 审查专家: ' + r.key + (r.ok ? '' : ' (执行失败: ' + String(r.error || 'run failed').slice(0, 120) + ')');");
		lines.push("  return head + '\\n\\n' + String(r.output || '(无输出)').slice(0, 6000);");
		lines.push("});");
		lines.push("const gateTask = [");
		for (const part of gateTaskParts) {
			lines.push(`  ${JSON.stringify(part)},`);
		}
		lines.push(`].join(" ") + '\\n\\n# 专家审查报告汇总 (Markdown)\\n\\n' + reviewerSections.join('\\n\\n---\\n\\n');`);
		lines.push("let gateRun;");
		lines.push("try {");
		lines.push("  gateRun = await runs.run('gate', {");
		lines.push(`    agent: ${JSON.stringify(LEAN_GATE_AGENT)},`);
		lines.push("    task: gateTask,");
		lines.push(`    cwd: ${JSON.stringify(workspacePath)},`);
		if (gateModel && gateModel !== "inherit") {
			lines.push(`    model: ${JSON.stringify(gateModelWithThinking)},`);
		}
		if (gateThinking && gateThinking !== "off" && gateThinking !== "false" && gateThinking !== "undefined") {
			lines.push(`    thinking: ${JSON.stringify(gateThinking)},`);
		}
		lines.push(`    toolBudget: { soft: ${budgets.gateToolBudget.soft}, hard: ${budgets.gateToolBudget.hard} },`);
		lines.push(`    turnBudget: { maxTurns: ${budgets.gateTurnBudget.maxTurns}, graceTurns: ${budgets.gateTurnBudget.graceTurns} },`);
		lines.push("  });");
		lines.push("} catch (gateLaunchError) {");
		lines.push("  try {");
		lines.push("    gateRun = await runs.run('gate-fallback', {");
		lines.push(`      agent: ${JSON.stringify(LEAN_GATE_AGENT)},`);
		lines.push("      task: gateTask,");
		lines.push(`      cwd: ${JSON.stringify(workspacePath)},`);
		lines.push(`      toolBudget: { soft: ${budgets.gateToolBudget.soft}, hard: ${budgets.gateToolBudget.hard} },`);
		lines.push(`      turnBudget: { maxTurns: ${budgets.gateTurnBudget.maxTurns}, graceTurns: ${budgets.gateTurnBudget.graceTurns} },`);
		lines.push("    });");
		lines.push("  } catch (fallbackError) {");
		lines.push("    gateRun = { ok: false, error: String(fallbackError.message || fallbackError), output: '' };");
		lines.push("  }");
		lines.push("}");
		lines.push("const gate = {");
		lines.push("  ok: gateRun ? gateRun.ok : false,");
		lines.push("  error: gateRun ? gateRun.error : 'gate failed',");
		lines.push("  output: gateRun ? gateRun.output : '',");
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
	lines.push("  reviewersShaped: reviewers.map((r) => ({");
	lines.push("    key: r.key,");
	lines.push("    ok: r.ok,");
	lines.push("    error: r.error,");
	lines.push("    output: r.output,");
	lines.push("  })),");
	lines.push("};");
	return lines.join("\n");
}

export function buildWorkflowReturnShape() {
	return "{ reviewers, reviewersShaped, gate }";
}