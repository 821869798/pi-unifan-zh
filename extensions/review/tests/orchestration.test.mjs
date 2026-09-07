import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/orchestration.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { buildSubagentOrchestrationPrompt } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// 执行实际生成的工作流，使用假运行器捕获请求，不启动模型或子代理。
async function runExample(prompt) {
  const example = prompt.match(/(`{3,})js\n([\s\S]*?)\n\1/);
  assert.ok(example, '应包含可执行的工作流示例');
  let request;
  new Function('subagent', example[2])(value => { request = value; });
  assert.equal(request.async, true);
  let tasks;
  const results = [{ output: '审查完成' }];
  const actual = await new AsyncFunction('runs', request.workflowScript)({
    all: async value => { tasks = value; return results; },
  });
  assert.equal(actual, results);
  return tasks;
}

test('所有专家在不同并发数下继承会话模型及全部思考档位', async () => {
  for (const thinking of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    for (const count of [2, 3, 4, 5, 6]) {
      const prompt = buildSubagentOrchestrationPrompt(count, true, '检查当前差异', { provider: '会话提供方', id: '会话模型' }, thinking);
      const tasks = await runExample(prompt);
      assert.equal(tasks.length, count);
      assert.equal(new Set(tasks.map(task => task.key)).size, count);
      for (const task of tasks) {
        assert.equal(task.model, `会话提供方/会话模型:${thinking}`);
        assert.match(task.task, /检查当前差异/);
      }
      assert.match(prompt, /capabilities: true/);
    }
  }
});

test('用户任务中的引号、换行和代码围栏不破坏工作流或模型参数', async () => {
  const target = '检查 "路径"\n```ts\nconst value = `${input}`;\n```\n反斜线 \\';
  const prompt = buildSubagentOrchestrationPrompt(3, false, target, { provider: '代理', id: '模型/别名' }, 'max');
  const tasks = await runExample(prompt);
  assert.ok(tasks.every(task => task.task.startsWith(target)));
  assert.ok(tasks.every(task => task.model === '代理/模型/别名:max'));
  assert.doesNotMatch(prompt, /（门禁裁决）/);
});
