import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Transpile typescript files on the fly into local .tmp dir for node native test runner
const repoTestsDir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const tempBuildDir = path.join(repoTestsDir, ".tmp-build-" + Date.now());
await mkdir(tempBuildDir, { recursive: true });
after(() => rm(tempBuildDir, { recursive: true, force: true }).catch(() => {}));

await mkdir(path.join(tempBuildDir, "src", "tools"), { recursive: true });
await mkdir(path.join(tempBuildDir, "src", "filters"), { recursive: true });
await mkdir(path.join(tempBuildDir, "src", "driver"), { recursive: true });
await writeFile(path.join(tempBuildDir, "package.json"), '{"type":"module"}');

const tsFiles = [
	"index",
	"src/tools/artifact-helper",
	"src/tools/session-checkpoint",
	"src/tools/workflow-state",
	"src/tools/workflow-dashboard",
	"src/filters/bash-output-filter",
	"src/filters/read-output-filter",
	"src/driver/trigger-matcher",
	"src/driver/work-loop-driver",
];

for (const name of tsFiles) {
	const source = await readFile(new URL(`../${name}.ts`, import.meta.url), "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
	}).outputText;
	await writeFile(path.join(tempBuildDir, `${name}.js`), output);
}

const {
	slugify,
	resolveArtifactRelativePath,
	resolveArtifactPath,
} = await import(pathToFileURL(path.join(tempBuildDir, "src/tools/artifact-helper.js")));

const { executeSessionCheckpoint } = await import(
	pathToFileURL(path.join(tempBuildDir, "src/tools/session-checkpoint.js"))
);

const { detectWorkflowState } = await import(
	pathToFileURL(path.join(tempBuildDir, "src/tools/workflow-state.js"))
);

const {
	deriveWorkflowSteps,
	buildWorkflowDashboard,
	buildWorkflowWidgetLines,
	renderProgressBar,
} = await import(pathToFileURL(path.join(tempBuildDir, "src/tools/workflow-dashboard.js")));

const { filterBashOutput } = await import(
	pathToFileURL(path.join(tempBuildDir, "src/filters/bash-output-filter.js"))
);

const { filterReadOutput } = await import(
	pathToFileURL(path.join(tempBuildDir, "src/filters/read-output-filter.js"))
);

const { default: workflowExtension } = await import(
	pathToFileURL(path.join(tempBuildDir, "index.js"))
);

const {
	parsePlanUnits,
	WorkLoopDriver,
	isExplicit03WorkTrigger,
	normalizeUnitId,
} = await import(
	pathToFileURL(path.join(tempBuildDir, "src/driver/work-loop-driver.js"))
);

test("artifact_helper: slugify and path resolution", async () => {
	assert.equal(slugify("My Feature 123!"), "my-feature-123");
	assert.equal(slugify("   --- spaces & symbols --- "), "spaces-symbols");

	const bRel = resolveArtifactRelativePath("brainstorm", "2026-09-17", "User Auth");
	assert.equal(bRel.replace(/\\/g, "/"), "docs/brainstorms/2026-09-17-user-auth-requirements.md");

	const pRel = resolveArtifactRelativePath("plan", "2026-09-17", "User Auth");
	assert.equal(pRel.replace(/\\/g, "/"), "docs/plans/2026-09-17-user-auth-plan.md");

	const sRel = resolveArtifactRelativePath("solution", "2026-09-17", "Windows Path Bug");
	assert.equal(sRel.replace(/\\/g, "/"), "docs/solutions/2026-09-17-windows-path-bug.md");

	const cRel = resolveArtifactRelativePath("checkpoint", "2026-09-17", "User Auth");
	assert.equal(cRel.replace(/\\/g, "/"), ".context/checkpoints/user-auth.json");
});

test("artifact_helper: ensureDir creates physical directory", async () => {
	const tmpDir = path.join(os.tmpdir(), `pi-test-artifact-${Date.now()}`);
	try {
		const res = await resolveArtifactPath({
			repoRoot: tmpDir,
			artifactType: "brainstorm",
			topic: "Quick Test",
			date: "2026-09-17",
			ensureDir: true,
		});
		assert.equal(res.createdDir, true);
		assert.ok(res.path.includes("docs"));
	} finally {
		await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
});

test("session_checkpoint: save, load, fail, retry, and list lifecycle", async () => {
	const tmpDir = path.join(os.tmpdir(), `pi-test-checkpoint-${Date.now()}`);
	try {
		// 1. Save checkpoint
		const saveRes = await executeSessionCheckpoint({
			operation: "save",
			repoRoot: tmpDir,
			planSlug: "core-feature",
			completedUnits: ["Unit 1: Types", "Unit 2: Parsers"],
		});
		assert.equal(saveRes.success, true);
		assert.equal(saveRes.checkpoint?.completedUnits.length, 2);

		// 2. Load checkpoint
		const loadRes = await executeSessionCheckpoint({
			operation: "load",
			repoRoot: tmpDir,
			planSlug: "core-feature",
		});
		assert.equal(loadRes.success, true);
		assert.deepEqual(loadRes.checkpoint?.completedUnits, ["Unit 1: Types", "Unit 2: Parsers"]);

		// 3. Record failure
		const failRes = await executeSessionCheckpoint({
			operation: "fail",
			repoRoot: tmpDir,
			planSlug: "core-feature",
			failedUnit: "Unit 3: API",
			error: "Network timeout in tests",
		});
		assert.equal(failRes.success, true);
		assert.equal(failRes.checkpoint?.failedUnit, "Unit 3: API");
		assert.equal(failRes.checkpoint?.error, "Network timeout in tests");

		// 4. Retry (clears failure)
		const retryRes = await executeSessionCheckpoint({
			operation: "retry",
			repoRoot: tmpDir,
			planSlug: "core-feature",
		});
		assert.equal(retryRes.success, true);
		assert.equal(retryRes.checkpoint?.failedUnit, undefined);
		assert.equal(retryRes.checkpoint?.error, undefined);

		// 5. List
		const listRes = await executeSessionCheckpoint({
			operation: "list",
			repoRoot: tmpDir,
		});
		assert.equal(listRes.success, true);
		assert.equal(listRes.checkpoints?.length, 1);
	} finally {
		await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
});

test("workflow_state: accurately recommends next stage based on artifacts", async () => {
	const tmpDir = path.join(os.tmpdir(), `pi-test-state-${Date.now()}`);
	try {
		// State 1: Empty repo -> recommends 01-brainstorm
		const state1 = await detectWorkflowState(tmpDir);
		assert.equal(state1.stage, "idle");
		assert.equal(state1.recommendedSkill, "01-brainstorm");

		// State 2: Has brainstorm -> recommends 02-plan
		await mkdir(path.join(tmpDir, "docs", "brainstorms"), { recursive: true });
		await writeFile(
			path.join(tmpDir, "docs", "brainstorms", "2026-09-17-feat-requirements.md"),
			"# Requirements",
		);
		const state2 = await detectWorkflowState(tmpDir);
		assert.equal(state2.stage, "brainstormed");
		assert.equal(state2.recommendedSkill, "02-plan");

		// State 3: Has plan -> recommends 03-work
		await mkdir(path.join(tmpDir, "docs", "plans"), { recursive: true });
		await writeFile(
			path.join(tmpDir, "docs", "plans", "2026-09-17-feat-plan.md"),
			"# Plan\n### Unit 1\n### Unit 2",
		);
		const state3 = await detectWorkflowState(tmpDir);
		assert.equal(state3.stage, "planned");
		assert.equal(state3.recommendedSkill, "03-work");
		assert.equal(state3.totalUnitsCount, 2);
		assert.equal(state3.remainingUnitsCount, 2);

		// State 3.5: Paused midway (Unit 1 done, Unit 2 pending) -> accurately recommends resuming 03-work
		await mkdir(path.join(tmpDir, ".context", "checkpoints"), { recursive: true });
		const cpPath = path.join(tmpDir, ".context", "checkpoints", "2026-09-17-feat-plan.json");
		await writeFile(
			cpPath,
			JSON.stringify({
				planSlug: "2026-09-17-feat-plan",
				completedUnits: ["Unit 1"],
				updatedAt: new Date(Date.now() + 1000).toISOString(),
			}),
		);
		const state35 = await detectWorkflowState(tmpDir);
		assert.equal(state35.stage, "working");
		assert.equal(state35.recommendedSkill, "03-work");
		assert.equal(state35.completedUnitsCount, 1);
		assert.equal(state35.remainingUnitsCount, 1);
		assert.equal(state35.nextUnitId, "Unit 2");

		// State 4: All units completed -> recommends 04-review
		await writeFile(
			cpPath,
			JSON.stringify({
				planSlug: "2026-09-17-feat-plan",
				completedUnits: ["Unit 1", "Unit 2"],
				updatedAt: new Date(Date.now() + 2000).toISOString(),
			}),
		);
		const state4 = await detectWorkflowState(tmpDir);
		assert.equal(state4.stage, "working");
		assert.equal(state4.recommendedSkill, "04-review");
		assert.equal(state4.remainingUnitsCount, 0);
	} finally {
		await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
});

test("bash_output_filter: compresses verbose terminal output", () => {
	const shortOutput = "Done in 0.5s.";
	const r1 = filterBashOutput({ command: "npm test", output: shortOutput, isError: false });
	assert.equal(r1.filtered, false);
	assert.equal(r1.output, shortOutput);

	const longOutput = Array.from({ length: 200 }, (_, i) => `Log line ${i}`).join("\n");
	const r2 = filterBashOutput({ command: "npm install", output: longOutput, isError: false });
	assert.equal(r2.filtered, true);
	assert.ok(r2.output.includes("lines truncated by workflow context optimizer"));
	assert.ok(r2.filteredBytes < r2.originalBytes);
});

test("read_output_filter: compresses lockfiles and large files", () => {
	const fakeLockfile = JSON.stringify({
		name: "demo",
		version: "1.0.0",
		lockfileVersion: 3,
		packages: { a: {}, b: {}, c: {}, d: {} },
	});
	// Make it exceed MAX_READ_CHARS to trigger threshold check
	const largeLockfile = fakeLockfile + " ".repeat(20000);
	const r1 = filterReadOutput({
		path: "package-lock.json",
		output: largeLockfile,
		isError: false,
	});
	assert.equal(r1.filtered, true);
	assert.equal(r1.strategy, "lockfile-summary");
	assert.ok(r1.output.includes("totalPackagesCount"));
});

test("workflowExtension: registers tools and command cleanly", async () => {
	const registeredTools = new Map();
	const registeredCommands = new Map();
	const listeners = new Map();

	const mockPi = {
		registerTool(def) {
			registeredTools.set(def.name, def);
		},
		registerCommand(name, def) {
			registeredCommands.set(name, def);
		},
		on(event, handler) {
			listeners.set(event, handler);
		},
	};

	workflowExtension(mockPi);

	assert.ok(registeredTools.has("workflow_state"));
	assert.ok(registeredTools.has("artifact_helper"));
	assert.ok(registeredTools.has("session_checkpoint"));
	assert.ok(registeredCommands.has("workflow"));
	assert.ok(listeners.has("tool_result"));
	assert.ok(listeners.has("before_agent_start"));
	assert.ok(listeners.has("input"));
	assert.ok(listeners.has("agent_settled"));

	// Verify input handler passes through standard inputs and handles pause
	const inputHandler = listeners.get("input");
	const resPassThrough = await inputHandler({ text: "/skill:01-brainstorm", source: "interactive" }, {});
	assert.deepEqual(resPassThrough, { action: "continue" });

	const resNormal = await inputHandler({ text: "1. 选第一个方案", source: "interactive" }, {});
	assert.deepEqual(resNormal, { action: "continue" });
});

test("parsePlanUnits: correctly extracts various unit headers and check-boxes", () => {
	const planMd = `
# Plan: Foo

## 4. Implementation Units

### Unit 0 — 探针：面板焦点 / 键盘 / IME (阻塞所有 UI 工作)
Some descriptions here.

### Unit 1: core 核心策略层
More descriptions.

- [ ] Unit 2: UI 渲染模块
- [x] Unit 3: 托盘与热键绑定

### Unit 4 — 最终集成与端到端验证
Done.
`;

	const units = parsePlanUnits(planMd);
	assert.equal(units.length, 5);
	assert.equal(units[0].id, "Unit 0");
	assert.equal(units[0].title, "Unit 0 — 探针：面板焦点 / 键盘 / IME (阻塞所有 UI 工作)");
	assert.equal(units[1].id, "Unit 1");
	assert.equal(units[2].id, "Unit 2");
	assert.equal(units[2].checked, false);
	assert.equal(units[3].id, "Unit 3");
	assert.equal(units[3].checked, true);
	assert.equal(units[4].id, "Unit 4");

	// Test Chinese step headers and list items
	const chinesePlanMd = `
# 中文任务规划
### 步骤 1: 基础设施配置
- [x] 步骤 2: 核心协议实现
- [ ] 步骤 3: 全量单元测试与回归
`;
	const zhUnits = parsePlanUnits(chinesePlanMd);
	assert.equal(zhUnits.length, 3);
	assert.equal(zhUnits[0].id, "步骤 1");
	assert.equal(zhUnits[1].id, "步骤 2");
	assert.equal(zhUnits[1].checked, true);
	assert.equal(zhUnits[2].id, "步骤 3");
	assert.equal(zhUnits[2].checked, false);
});

test("WorkLoopDriver: autonomous lifecycle and prompt generation", async () => {
	const testRoot = path.join(tempBuildDir, "loop-test-" + Date.now());
	const plansDir = path.join(testRoot, "docs", "plans");
	const checkpointsDir = path.join(testRoot, ".context", "checkpoints");
	await mkdir(plansDir, { recursive: true });
	await mkdir(checkpointsDir, { recursive: true });

	const planFile = path.join(plansDir, "2026-09-17-test-plan.md");
	const planContent = `
# Test Plan
### Unit 0 — Setup
### Unit 1 — Implementation
`;
	await writeFile(planFile, planContent, "utf-8");

	const driver = new WorkLoopDriver(testRoot);
	const startRes = await driver.start(planFile);

	assert.equal(startRes.success, true);
	assert.equal(startRes.status.isActive, true);
	assert.equal(startRes.status.allUnits.length, 2);
	assert.equal(startRes.status.currentUnit, "Unit 0");

	const prompt = driver.generatePromptForNextUnit();
	assert.ok(prompt.includes("Unit 0"));
	assert.ok(prompt.includes("TDD"));
	assert.ok(prompt.includes("session_checkpoint"));

	let userMessagesSent = [];
	const mockPi = {
		sendUserMessage(msg, opts) {
			userMessagesSent.push({ msg, opts });
		},
	};

	const mockCtx = {
		signal: undefined,
		ui: {
			notify() {},
			setStatus() {},
		},
	};

	// 1. Simulate agent completed Unit 0 and wrote checkpoint
	const cpFile = path.join(checkpointsDir, "2026-09-17-test-plan.json");
	await writeFile(
		cpFile,
		JSON.stringify({
			planPath: planFile,
			planSlug: "2026-09-17-test-plan",
			completedUnits: ["Unit 0"],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}),
		"utf-8",
	);

	await driver.onAgentSettled(mockCtx, mockPi);

	const statusAfterUnit0 = driver.getStatus();
	assert.equal(statusAfterUnit0.completedUnits.includes("Unit 0"), true);
	assert.equal(statusAfterUnit0.currentUnit, "Unit 1");
	assert.equal(statusAfterUnit0.isActive, true);

	// 2. Simulate agent completed Unit 1 (all done!)
	await writeFile(
		cpFile,
		JSON.stringify({
			planPath: planFile,
			planSlug: "2026-09-17-test-plan",
			completedUnits: ["Unit 0", "Unit 1"],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}),
		"utf-8",
	);

	await driver.onAgentSettled(mockCtx, mockPi);

	const statusDone = driver.getStatus();
	assert.equal(statusDone.isActive, false);
	assert.equal(statusDone.remainingUnits.length, 0);

	// Verified that it automatically transitioned to 04-review
	assert.ok(userMessagesSent.some((m) => m.msg.includes("04-review")));

	driver.cancelTimer();
});

test("WorkLoopDriver: records failure history and triggers Stop-The-Line valve on 3 failures", async () => {
	const testRoot = path.join(tempBuildDir, "loop-failure-test-" + Date.now());
	const plansDir = path.join(testRoot, "docs", "plans");
	const checkpointsDir = path.join(testRoot, ".context", "checkpoints");
	await mkdir(plansDir, { recursive: true });
	await mkdir(checkpointsDir, { recursive: true });

	const planFile = path.join(plansDir, "fail-plan.md");
	await writeFile(planFile, "# Fail Plan\n### Unit 0 — Broken", "utf-8");

	const driver = new WorkLoopDriver(testRoot);
	await driver.start(planFile);

	const cpFile = path.join(checkpointsDir, "fail-plan.json");
	const mockPi = { sendUserMessage() {} };
	const mockCtx = {
		signal: undefined,
		ui: { notify() {}, setStatus() {} },
	};

	// 1st failure
	await writeFile(
		cpFile,
		JSON.stringify({
			planPath: planFile,
			planSlug: "fail-plan",
			completedUnits: [],
			failedUnit: "Unit 0",
			error: "AssertionError: expected 1 to equal 2",
			updatedAt: new Date().toISOString(),
		}),
	);
	await driver.onAgentSettled(mockCtx, mockPi);
	assert.equal(driver.getStatus().consecutiveFailures, 1);
	assert.equal(driver.getStatus().failureHistory.length, 1);
	assert.equal(driver.getStatus().failureHistory[0].unit, "Unit 0");
	assert.ok(driver.getStatus().failureHistory[0].error.includes("AssertionError"));
	assert.equal(driver.getStatus().isActive, true);

	// 2nd failure
	await driver.onAgentSettled(mockCtx, mockPi);
	assert.equal(driver.getStatus().consecutiveFailures, 2);

	// 3rd failure -> Stop-The-Line triggered!
	await driver.onAgentSettled(mockCtx, mockPi);
	const status = driver.getStatus();
	assert.equal(status.consecutiveFailures, 3);
	assert.equal(status.isActive, false); // Paused by Stop-The-Line
	assert.equal(status.failureHistory.length, 3);

	driver.cancelTimer();
});

test("isExplicit03WorkTrigger: accurately identifies canonical 03-work invocations vs harmless inputs", async () => {
	// Should match canonical /skill:03-work, Pi's expanded XML, strict natural language, and engine follow-up
	assert.equal(isExplicit03WorkTrigger("/skill:03-work"), true);
	assert.equal(isExplicit03WorkTrigger('<skill name="03-work" location="extensions/workflow/skills/03-work/SKILL.md">'), true);
	assert.equal(isExplicit03WorkTrigger("开始干活"), true);
	assert.equal(isExplicit03WorkTrigger("开始实现"), true);
	assert.equal(isExplicit03WorkTrigger("开始编码"), true);
	assert.equal(isExplicit03WorkTrigger("开始写代码"), true);
	assert.equal(isExplicit03WorkTrigger("执行03-work"), true);
	assert.equal(isExplicit03WorkTrigger("继续干活"), true);
	assert.equal(isExplicit03WorkTrigger("恢复干活"), true);
	assert.equal(isExplicit03WorkTrigger("resume work"), true);
	assert.equal(isExplicit03WorkTrigger("【03-work 自主循环驱动引擎 · 自动化续跑指令】"), true);

	// Plain numbers or informal abbreviations must NEVER trigger (strictly require canonical name)
	assert.equal(isExplicit03WorkTrigger("/skill:03"), false);
	assert.equal(isExplicit03WorkTrigger("03"), false);
	assert.equal(isExplicit03WorkTrigger("/03"), false);
	assert.equal(isExplicit03WorkTrigger("03-work"), false);
	assert.equal(isExplicit03WorkTrigger("/03-work"), false);
	assert.equal(isExplicit03WorkTrigger("/work"), false);

	// Must NEVER match other skills or normal dialogue (prevents false auto-starts!)
	assert.equal(isExplicit03WorkTrigger("00"), false);
	assert.equal(isExplicit03WorkTrigger("/skill:00-next"), false);
	assert.equal(isExplicit03WorkTrigger("01"), false);
	assert.equal(isExplicit03WorkTrigger("/skill:01-brainstorm"), false);
	assert.equal(isExplicit03WorkTrigger("02"), false);
	assert.equal(isExplicit03WorkTrigger("/skill:02-plan"), false);
	assert.equal(isExplicit03WorkTrigger("04"), false);
	assert.equal(isExplicit03WorkTrigger("/skill:04-review"), false);
	assert.equal(isExplicit03WorkTrigger("05"), false);
	assert.equal(isExplicit03WorkTrigger("/skill:05-learn"), false);
	assert.equal(isExplicit03WorkTrigger("我想了解一下03步骤是什么"), false);
	assert.equal(isExplicit03WorkTrigger("继续讨论一下需求细节"), false);
	assert.equal(isExplicit03WorkTrigger("请帮我恢复之前被删除的代码"), false);
	assert.equal(isExplicit03WorkTrigger(""), false);
	assert.equal(isExplicit03WorkTrigger("   "), false);
});

test("normalizeUnitId: correctly normalizes unit representations to standard IDs", async () => {
	const knownUnits = [
		{ id: "Unit 0", title: "Unit 0: DB Schema", raw: "### Unit 0: DB Schema" },
		{ id: "Unit 1", title: "Unit 1: API Endpoint", raw: "### Unit 1: API Endpoint" },
	];

	assert.equal(normalizeUnitId("Unit 0: DB Schema", knownUnits), "Unit 0");
	assert.equal(normalizeUnitId("unit 0", knownUnits), "Unit 0");
	assert.equal(normalizeUnitId("0", knownUnits), "Unit 0");
	assert.equal(normalizeUnitId("1", knownUnits), "Unit 1");
	assert.equal(normalizeUnitId("### Unit 0 — Alpha"), "Unit 0");
	assert.equal(normalizeUnitId("步骤 2: 业务逻辑"), "步骤 2");
	assert.equal(normalizeUnitId(""), "");
});

test("workflow-dashboard: derives all 5 steps and renders goal-style status dashboard", async () => {
	const mockState = {
		repoRoot: "/test/repo",
		hasArtifacts: true,
		stage: "planned",
		recommendedSkill: "03-work",
		recommendationReason: "计划已就绪",
		brainstorms: [{ filename: "requirements.md", relativePath: "docs/brainstorms/requirements.md", mtimeMs: 100 }],
		plans: [{ filename: "plan.md", relativePath: "docs/plans/plan.md", mtimeMs: 200 }],
		solutions: [],
		checkpoints: [],
		latestBrainstorm: { filename: "requirements.md", relativePath: "docs/brainstorms/requirements.md", mtimeMs: 100 },
		latestPlan: { filename: "plan.md", relativePath: "docs/plans/plan.md", mtimeMs: 200 },
		totalUnitsCount: 4,
		completedUnitsCount: 1,
		remainingUnitsCount: 3,
		nextUnitId: "Unit 1",
	};

	const mockWorkStatus = {
		isActive: true,
		planPath: "/test/repo/docs/plans/plan.md",
		planSlug: "plan",
		allUnits: ["Unit 0", "Unit 1", "Unit 2", "Unit 3"],
		completedUnits: ["Unit 0"],
		remainingUnits: ["Unit 1", "Unit 2", "Unit 3"],
		currentUnit: "Unit 1",
		failedUnit: null,
		consecutiveFailures: 0,
		currentRunCount: 1,
		maxRuns: 50,
	};

	// 1. Check all 5 steps derivation
	const steps = deriveWorkflowSteps(mockState, mockWorkStatus);
	assert.equal(steps.length, 5);
	assert.equal(steps[0].number, "01");
	assert.equal(steps[0].id, "01-brainstorm");
	assert.equal(steps[0].status, "completed");

	assert.equal(steps[1].number, "02");
	assert.equal(steps[1].id, "02-plan");
	assert.equal(steps[1].status, "completed");

	assert.equal(steps[2].number, "03");
	assert.equal(steps[2].id, "03-work");
	assert.equal(steps[2].status, "in_progress");
	assert.equal(steps[2].isCurrent, true);

	assert.equal(steps[3].number, "04");
	assert.equal(steps[3].id, "04-review");

	assert.equal(steps[4].number, "05");
	assert.equal(steps[4].id, "05-learn");

	// 2. Check full dashboard rendering
	const dashboard = buildWorkflowDashboard(mockState, mockWorkStatus);
	assert.ok(dashboard.includes("Workflow Dashboard"));
	assert.ok(dashboard.includes("▶ [03] 03-work"));
	assert.ok(dashboard.includes("[01] 01-brainstorm"));
	assert.ok(dashboard.includes("[02] 02-plan"));
	assert.ok(dashboard.includes("[04] 04-review"));
	assert.ok(dashboard.includes("[05] 05-learn"));
	assert.ok(dashboard.includes("Esc/Ctrl+C"));
	assert.ok(dashboard.includes("单元进度:"));

	// 3. Check progress bar helper
	assert.equal(renderProgressBar(2, 4, 8), "████░░░░");
	assert.equal(renderProgressBar(4, 4, 8), "████████");
	assert.equal(renderProgressBar(0, 4, 8), "░░░░░░░░");

	// 4. Check widget lines
	const widgetLines = buildWorkflowWidgetLines(mockState, mockWorkStatus);
	assert.ok(widgetLines[0].includes("03-work"));
	assert.ok(widgetLines[0].includes("Unit 1"));
});

test("WorkLoopDriver: Esc/Abort interruption safely disarms autonomous driving", async () => {
	const testRoot = path.join(tempBuildDir, "loop-interrupt-test-" + Date.now());
	const plansDir = path.join(testRoot, "docs", "plans");
	await mkdir(plansDir, { recursive: true });

	const planFile = path.join(plansDir, "interrupt-plan.md");
	await writeFile(planFile, "# Plan\n### Unit 0 — Alpha\n### Unit 1 — Beta", "utf-8");

	const driver = new WorkLoopDriver(testRoot);
	await driver.start(planFile);
	assert.equal(driver.getStatus().isActive, true);

	// 1. Simulate pause triggered by Esc / user action
	await driver.pause("用户按 Esc 中断");
	assert.equal(driver.getStatus().isActive, false);
	assert.ok(driver.getStatus().lastMessage.includes("用户按 Esc 中断"));

	// 2. Simulate agent_settled called while paused -> must NOT start next turn
	let sendCalled = false;
	const mockPi = {
		sendUserMessage() {
			sendCalled = true;
		},
	};
	const mockCtx = {
		signal: undefined,
		ui: { notify() {}, setStatus() {} },
	};
	await driver.onAgentSettled(mockCtx, mockPi);
	assert.equal(sendCalled, false);
	assert.equal(driver.getStatus().isActive, false);

	// 3. Test onAgentSettled with ctx.signal.aborted
	await driver.start(planFile);
	assert.equal(driver.getStatus().isActive, true);
	const abortedCtx = {
		signal: { aborted: true },
		ui: { notify() {}, setStatus() {} },
	};
	await driver.onAgentSettled(abortedCtx, mockPi);
	assert.equal(driver.getStatus().isActive, false);
	assert.equal(sendCalled, false);

	// 4. Test onAgentSettled with last assistant message aborted (Ctrl+C / Esc aftermath)
	await driver.start(planFile);
	assert.equal(driver.getStatus().isActive, true);
	const sessionAbortedCtx = {
		signal: undefined,
		sessionManager: {
			getBranch() {
				return [
					{ type: "message", message: { role: "user", content: "hello" } },
					{ type: "message", message: { role: "assistant", stopReason: "aborted", content: "stopping..." } },
				];
			},
		},
		ui: { notify() {}, setStatus() {} },
	};
	await driver.onAgentSettled(sessionAbortedCtx, mockPi);
	assert.equal(driver.getStatus().isActive, false);
	assert.equal(sendCalled, false);
	assert.ok(driver.getStatus().lastMessage.includes("中断"));
});

test("E2E Lifecycle: 01 brainstorm -> 02 plan -> 01 rollback -> 03 work -> compact dashboard & widget", async () => {
	const testRoot = path.join(tempBuildDir, "e2e-workflow-" + Date.now());
	const brainstormsDir = path.join(testRoot, "docs", "brainstorms");
	const plansDir = path.join(testRoot, "docs", "plans");
	await mkdir(brainstormsDir, { recursive: true });
	await mkdir(plansDir, { recursive: true });

	// 1. Initial State: No artifacts -> recommends 01-brainstorm
	let state = await detectWorkflowState(testRoot);
	assert.equal(state.recommendedSkill, "01-brainstorm");

	// 2. User creates 01 brainstorm artifact
	const bsFile = path.join(brainstormsDir, "2026-09-18-auth-requirements.md");
	await writeFile(bsFile, "# Auth Requirements\nScope: login, register", "utf-8");

	state = await detectWorkflowState(testRoot);
	assert.equal(state.recommendedSkill, "02-plan");
	assert.equal(state.brainstorms.length, 1);

	// 3. User creates 02 plan artifact
	const planFile = path.join(plansDir, "2026-09-18-auth-plan.md");
	await writeFile(
		planFile,
		"# Auth Plan\n### Unit 0 — DB Schema\n### Unit 1 — API Route\n### Unit 2 — Tests",
		"utf-8",
	);

	state = await detectWorkflowState(testRoot);
	assert.equal(state.recommendedSkill, "03-work");
	assert.equal(state.totalUnitsCount, 3);

	// 4. User is in 02, realizes requirements need changes -> Rolls back to 01 via /skill:01-brainstorm
	// In standard Pi, user runs /skill:01-brainstorm to revisit requirements
	await writeFile(bsFile, "# Auth Requirements\nScope: login, register, oauth2", "utf-8");

	// 5. User returns to 02 via /skill:02-plan and updates the plan
	await writeFile(
		planFile,
		"# Auth Plan\n### Unit 0 — DB Schema\n### Unit 1 — API Route & OAuth2\n### Unit 2 — Tests",
		"utf-8",
	);

	state = await detectWorkflowState(testRoot);
	assert.equal(state.recommendedSkill, "03-work");

	// 6. User enters 03 -> starts autonomous work via /skill:03-work
	assert.equal(isExplicit03WorkTrigger("/skill:03-work"), true);
	const driver = new WorkLoopDriver(testRoot);
	const startRes = await driver.start(planFile);
	assert.equal(startRes.success, true);
	assert.equal(startRes.status.isActive, true);

	// 7. Verify Dashboard height is strictly 7 lines
	const dashboard = buildWorkflowDashboard(state, driver.getStatus());
	const dashboardLines = dashboard.trim().split("\n");
	assert.equal(dashboardLines.length, 7, "Dashboard must strictly occupy exactly 7 lines");
	assert.ok(dashboard.includes("▶ [03] 03-work"));
	assert.ok(dashboard.includes("✓ [01] 01-brainstorm"));
	assert.ok(dashboard.includes("✓ [02] 02-plan"));

	// 8. Verify Widget height is strictly 1 line
	const widgetLines = buildWorkflowWidgetLines(state, driver.getStatus());
	assert.equal(widgetLines.length, 1, "Widget must strictly occupy exactly 1 line");
	assert.ok(widgetLines[0].includes("03-work"));
	assert.ok(widgetLines[0].includes("01✓ 02✓ 03▶"));

	// 9. Manual interruption (Esc) stops the loop
	await driver.pause("User hit Esc");
	assert.equal(driver.getStatus().isActive, false);

	// Post-pause widget is also strictly 1 line
	const pausedWidgetLines = buildWorkflowWidgetLines(state, driver.getStatus());
	assert.equal(pausedWidgetLines.length, 1);
	assert.ok(pausedWidgetLines[0].includes("已暂停"));
});


