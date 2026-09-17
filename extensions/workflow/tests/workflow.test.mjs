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
	"src/filters/bash-output-filter",
	"src/filters/read-output-filter",
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

const { filterBashOutput } = await import(
	pathToFileURL(path.join(tempBuildDir, "src/filters/bash-output-filter.js"))
);

const { filterReadOutput } = await import(
	pathToFileURL(path.join(tempBuildDir, "src/filters/read-output-filter.js"))
);

const { default: workflowExtension } = await import(
	pathToFileURL(path.join(tempBuildDir, "index.js"))
);

const { parsePlanUnits, WorkLoopDriver } = await import(
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

test("workflowExtension: registers tools and command cleanly", () => {
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
	assert.equal(units[3].id, "Unit 3");
	assert.equal(units[4].id, "Unit 4");
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
