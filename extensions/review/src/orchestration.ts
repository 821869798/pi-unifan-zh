interface ReviewExpert {
	id: string;
	label: string;
	desc: string;
	task: string;
}

const ALL_EXPERTS: ReviewExpert[] = [
	{
		id: "pi-review.bugbot",
		label: "Bug 猎手 (Bugbot)",
		desc: "逻辑缺陷、空指针、边界溢出、死锁与运行时崩溃",
		task: "深入排查本次代码改动中的业务逻辑缺陷、空指针、边界异常、并发竞态与未捕获的运行时异常",
	},
	{
		id: "pi-review.security-review",
		label: "安全专家 (Security)",
		desc: "输入参数合法性校验、跨目录边界防护与权限隔离",
		task: "深入排查本次代码改动中的防御性编码缺陷、外部输入未做类型/范围校验、边界防护不足等健壮性隐患",
	},
	{
		id: "pi-review.perf-review",
		label: "性能探针 (Perf)",
		desc: "循环内GC内存分配、CPU热点消耗、算法复杂度与资源泄露",
		task: "深入排查本次代码改动中的性能退化、高频循环内无谓内存分配 (GC压力) 与算法复杂度",
	},
	{
		id: "pi-review.claude-md-compliance",
		label: "契约合规 (Compliance)",
		desc: "架构契约、设计模式、模块边界与规范遵循",
		task: "排查本次代码改动是否违反项目既有架构契约、模块封装规范与规范指南",
	},
	{
		id: "pi-review.code-comments",
		label: "注释与可读性 (Comments)",
		desc: "注释与代码逻辑倒挂、误导性命名与维护性隐患",
		task: "排查本次代码改动中的可读性隐患、注释与逻辑不符、误导性命名与维护风险",
	},
	{
		id: "pi-review.history-context",
		label: "历史脉络 (History)",
		desc: "结合 Git 历史演进判断意图，防止历史问题回归",
		task: "结合代码演变历史，排查本次改动是否破坏既有历史契约或重现已知缺陷",
	},
];

export function buildSubagentOrchestrationPrompt(
	concurrency: number,
	gateEnabled: boolean,
	targetInstruction: string,
	sessionModel: { provider: string; id: string },
	thinkingLevel: string,
): string {
	const count = Math.min(6, Math.max(2, concurrency));
	const selected = ALL_EXPERTS.slice(0, count);

	const listText = selected.map((exp, idx) => `${idx + 1}. **${exp.label}** (\`${exp.id}\`)：${exp.desc}`).join("\n");
	// 每次执行显式固定当前会话模型和档位，避免子代理默认配置覆盖会话选择。
	const model = `${sessionModel.provider}/${sessionModel.id}:${thinkingLevel}`;
	const tasks = selected.map((exp) => ({
		key: exp.id,
		agent: exp.id,
		model,
		task: `${targetInstruction}\n\n【专项排查分工】：${exp.task}`,
	}));
	const callsExample = `subagent(${JSON.stringify({
		async: true,
		workflowScript: `const results = await runs.all(${JSON.stringify(tasks)});\nreturn results;`,
	}, null, 2)});`;

	const maxBackticks = (callsExample.match(/`+/g) || []).reduce((max, m) => Math.max(max, m.length), 2);
	const fence = "`".repeat(maxBackticks + 1);

	return `## 🚀 执行方式：多 Subagent 并发专家审查 (当前配置并发数: ${count} 个专家)

当前已配置并行启动以下 ${count} 个专家子代理进行分工审查：

${listText}

### 协作审查执行规范：
1. **并发调用子代理**：先调用 \`subagent({ action: "list", capabilities: true })\`，确认上述专家均可执行且未禁用；再通过下方**一个异步工作流**并行启动全部专家。每个专家必须使用示例中的 \`model\` 参数，继承本次会话模型与思考档位（${thinkingLevel}），不得省略或改用代理默认档位。运行失败时报告具体原因并停止，不得静默更换模型或执行方式：
${fence}js
${callsExample}
${fence}
2. **主审裁判长汇总整理**：当所有专家子代理执行完毕返回发现后，请你作为主审裁判长${gateEnabled ? "（门禁裁决）" : ""}：
   - 全面综合各专家的审查意见，对相同问题进行去重，剔除误报和低置信度内容（注意：项目中合法的内部 GM / Debug 调试工具在确保与正式生产环境隔离的前提下免检）。
   - 严格按照《核心代码审查准则》的 **[P0~P3]** 等级标准排布审查清单。
   - 给出最终综合裁决与一句话中文总评。
3. **语言强制要求**：所有任务入参、思考分析过程、综合汇报与最终报告必须 100% 为纯正中文，严禁出现任何英文段落或未翻译小标题！`;
}
