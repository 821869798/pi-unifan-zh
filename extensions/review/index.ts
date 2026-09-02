import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { parseReviewArgs } from "./src/cli-args.js";
import {
	DEFAULT_CONFIG,
	configPath,
	loadConfig,
	mergeWithDefaults,
	resolveModel,
	validateConfig,
	writeConfig,
} from "./src/config.js";
import { prepareRun } from "./src/review-run.js";
import { registerReviewReportTool } from "./src/tool-wrapper.js";
import { registerPiReviewRenderer } from "./src/tui-renderer.js";

function parentModelId(ctx: ExtensionCommandContext): string | undefined {
	const m = ctx.model;
	if (!m) return undefined;
	return `${m.provider}/${m.id}`;
}

export default function (pi: ExtensionAPI) {
	registerReviewReportTool(pi);
	registerPiReviewRenderer(pi);
	pi.registerCommand("review", {
		description: "启动 AI 并发代码审查 (支持多专家子代理 + 门禁总裁判系统)。--lite = 极速单专家审查。",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trimStart();
			const tokens = trimmed.split(/\s+/).filter(Boolean);
			const last = tokens[tokens.length - 1] ?? "";
			if (last.startsWith("--")) {
				return [
					{ value: "--lite", label: "--lite", description: "极速单专家审查 (无门禁，低延迟省 Token)" },
					{ value: "--gate-model", label: "--gate-model", description: "指定当前审查的门禁裁判模型" },
				].filter((o) => o.value.startsWith(last));
			}
			return null;
		},
		handler: async (args, ctx) => {
			const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
				else console.log(`pi-review: ${msg}`);
			};

			try {
				const parsed = parseReviewArgs(args);
				const { config, legacyWarnings } = loadConfig();
				for (const w of legacyWarnings) notify(`pi-review 提示: ${w}`, "warning");

				pi.sendMessage({
					customType: "pi-review",
					content: parsed.input ? `/review ${parsed.input}` : "/review",
					display: true,
				});

				if (parsed.noSpawn) {
					const dryRunText = await renderDryRun(ctx, parsed, config);
					pi.sendMessage({ customType: "pi-review", content: dryRunText, display: true });
					return;
				}

				const prepared = await prepareRun({ cwd: ctx.cwd, input: parsed.input, lite: parsed.lite, gateModel: parsed.gateModel });
				if (!prepared) {
					notify("没有检测到需要审查的内容 (未找到修改、PR 或非 Git 仓库)。", "info");
					return;
				}

				pi.sendMessage(
					{
						customType: "pi-review-directive",
						content: prepared.directiveText,
						display: false,
					},
					{ triggerTurn: true },
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				notify(`代码审查启动失败: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("review-config", {
		description: "编辑代码审查配置 (~/.pi/agent/pi-review.json)",
		handler: async (_args, ctx) => {
			const path = configPath();
			if (!existsSync(path)) {
				writeConfig(DEFAULT_CONFIG);
			}

			let raw: string;
			if (ctx.hasUI) {
				const current = readFileSync(path, "utf-8");
				const edited = await ctx.ui.editor("编辑 pi-review 配置文件 (JSON)", current);
				if (edited === undefined) {
					ctx.ui.notify("已取消编辑配置。", "info");
					return;
				}
				raw = edited;
			} else {
				const editor = process.env.VISUAL ?? process.env.EDITOR;
				if (!editor) {
					ctx.ui.notify(`请设置 $EDITOR 或在 TUI 模式下使用。配置文件路径: ${path}`, "warning");
					return;
				}
				await pi.exec(editor, [path], { cwd: ctx.cwd });
				raw = readFileSync(path, "utf-8");
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				ctx.ui.notify("JSON 格式无效 — 配置未保存。", "error");
				return;
			}

			const merged = mergeWithDefaults(parsed);
			const validation = validateConfig(merged);
			if (!validation.ok) {
				ctx.ui.notify(`配置存在错误: ${validation.errors.join("; ")}`, "error");
				return;
			}
			writeConfig(merged);
			ctx.ui.notify("pi-review 配置文件已保存。", "info");
		},
	});

	pi.registerCommand("review-agents", {
		description: "查看当前内置审查专家与模型分配清单",
		handler: async (_args, ctx) => {
			const { config } = loadConfig();
			const parent = parentModelId(ctx);
			const lines: string[] = ["## 🔍 pi-review 审查专家与门禁状态", ""];
			for (const r of Object.values(config.reviewers)) {
				const model = resolveModel(r.model, parent);
				const status = r.enabled ? "已启用 (enabled)" : "已禁用 (disabled)";
				lines.push(`- **${r.id}** (${r.label}) — ${status}`);
				lines.push(`  - 模型: ${model}`);
				lines.push(`  - 思考深度: ${r.thinking ?? "跟随主会话"}`);
			}
			lines.push("");
			lines.push(`门禁裁判长 (Gate): ${resolveModel(config.gate.model, parent)} · 过滤置信度阈值: ${config.gate.threshold} · 判定策略: ${config.gate.verdictPolicy}`);
			lines.push(`路由模式: ${config.routing.mode}`);
			const body = lines.join("\n");
			pi.sendMessage({ customType: "pi-review-agents", content: body, display: true });
		},
	});

	pi.registerCommand("review-show", {
		description: "重新显示最近一次的代码审查报告",
		handler: async (_args, ctx) => {
			let last: { markdown?: string } | null = null;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (
					entry.type === "custom" &&
					(entry as { customType?: string }).customType === "pi-review" &&
					(entry as { data?: { markdown?: string } }).data?.markdown
				) {
					last = (entry as { data: { markdown?: string } }).data;
				}
			}
			if (!last?.markdown) {
				ctx.ui.notify("当前会话中未找到任何历史审查报告。", "info");
				return;
			}
			pi.sendMessage({ customType: "pi-review", content: last.markdown, display: true });
		},
	});
}

/** Cheap human summary for `--no-spawn`. */
async function renderDryRun(
	ctx: ExtensionCommandContext,
	parsed: ReturnType<typeof parseReviewArgs>,
	config: ReturnType<typeof loadConfig>["config"],
): Promise<string> {
	const prepared = await prepareRun({
		cwd: ctx.cwd,
		input: parsed.input,
		lite: parsed.lite,
		gateModel: parsed.gateModel,
		cleanup: false,
	});
	if (!prepared) return "pi-review 试运行: 没有找到需要审查的代码。";
	const m = prepared.manifest;
	const gate = config.gate;
	const lines = [
		"pi-review 试运行摘要",
		`审查目标: ${m.targetLabel}`,
		`模式: ${parsed.lite ? "极速单专家 (无门禁)" : `多专家并发 (${m.targetKind})`}`,
		`运行 ID: ${m.runId}`,
		`工作区目录: ${m.workspacePath}`,
		`Diff 哈希: ${m.diffSha256.slice(0, 16)}…`,
		`变更文件数: ${m.changedFiles.length}`,
		`纯文档变更: ${m.docsOnly ? "是" : "否"}`,
		`包含 Git 历史: ${m.historyAvailable ? "是" : "否"}`,
		`置信度阈值: ${gate.threshold}`,
		`门禁裁判: ${gate.enabled ? `已启用 (${resolveModel(gate.model, undefined)})` : "未启用"}`,
	];
	if (m.rulePaths.length > 0) lines.push(`规范文件: ${m.rulePaths.join(", ")}`);
	return lines.join("\n");
}