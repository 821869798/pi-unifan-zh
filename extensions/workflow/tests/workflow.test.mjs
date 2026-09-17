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
await writeFile(path.join(tempBuildDir, "package.json"), '{"type":"module"}');

const tsFiles = [
	"index",
	"src/tools/artifact-helper",
	"src/tools/session-checkpoint",
	"src/tools/workflow-state",
	"src/filters/bash-output-filter",
	"src/filters/read-output-filter",
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
		await writeFile(path.join(tmpDir, "docs", "plans", "2026-09-17-feat-plan.md"), "# Plan");
		const state3 = await detectWorkflowState(tmpDir);
		assert.equal(state3.stage, "planned");
		assert.equal(state3.recommendedSkill, "03-work");

		// State 4: Has completed checkpoint -> recommends 04-review
		await mkdir(path.join(tmpDir, ".context", "checkpoints"), { recursive: true });
		await writeFile(
			path.join(tmpDir, ".context", "checkpoints", "feat.json"),
			JSON.stringify({
				planSlug: "feat",
				completedUnits: ["Unit 1", "Unit 2"],
				updatedAt: new Date(Date.now() + 1000).toISOString(),
			}),
		);
		const state4 = await detectWorkflowState(tmpDir);
		assert.equal(state4.stage, "working");
		assert.equal(state4.recommendedSkill, "04-review");
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
});
