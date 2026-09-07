import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-responses';

// 在临时目录编译并运行真实命令，不访问开发仓库的提交记录。
const root = await mkdtemp(join(tmpdir(), 'pi-commit-test-'));
after(() => rm(root, { recursive: true, force: true }));
await mkdir(join(root, 'src'));
await writeFile(join(root, 'package.json'), '{"type":"module"}');
for (const name of ['index', 'src/git', 'src/prompt']) {
  const source = await readFile(new URL(`../${name}.ts`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  await writeFile(join(root, `${name}.js`), output);
}
const { default: register, generateCommitMessage } = await import(pathToFileURL(join(root, 'index.js')));
const { getStagedFiles } = await import(pathToFileURL(join(root, 'src/git.js')));
const model = { id: '当前模型', provider: '当前提供方' };
function context(complete) {
  const provider = { streamSimple: (...args) => ({ result: () => complete(...args) }) };
  return {
    model,
    thinkingLevel: 'high',
    modelRegistry: {
      getProvider: () => provider,
      getProviderAuth: async () => ({ auth: { apiKey: '测试凭据' } }),
    },
  };
}
function response(text, stopReason = 'stop') { return { content: [{ type: 'text', text }], stopReason }; }

test('通过宿主统一接口继承当前模型并返回业务日志', async () => {
  const ctx = context(async (actualModel, prompt, options) => {
    assert.equal(actualModel, model);
    assert.match(prompt.messages[0].content[0].text, /修复冲线残留/);
    assert.equal(options.maxTokens, 4096);
    assert.equal(options.reasoning, 'high');
    return response('```text\nfix(racing): 清理冲线特效残留\n```');
  });
  assert.equal(await generateCommitMessage(ctx, '+ 清理特效', ['角色.cs'], '修复冲线残留'), 'fix(racing): 清理冲线特效残留');
});

test('继承全部会话思考档位及宿主认证、代理与环境，不修改原模型', async () => {
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const signal = new AbortController().signal;
    const auth = { apiKey: '测试凭据', baseUrl: 'https://proxy.example.invalid/v1', headers: { 'x-test': '测试头' } };
    const env = { TEST_PROVIDER_REGION: '测试区域' };
    const ctx = context(async (actualModel, _prompt, options) => {
      assert.equal(actualModel.id, model.id);
      assert.equal(actualModel.baseUrl, auth.baseUrl);
      assert.equal(model.baseUrl, undefined);
      assert.equal(options.reasoning, level === 'off' ? undefined : level);
      assert.equal(options.apiKey, auth.apiKey);
      assert.equal(options.headers, auth.headers);
      assert.equal(options.env, env);
      assert.equal(options.signal, signal);
      return response('fix: 修复思考档位继承');
    });
    ctx.thinkingLevel = level;
    ctx.signal = signal;
    ctx.modelRegistry.getProviderAuth = async () => ({ auth, env });
    await generateCommitMessage(ctx, 'diff', ['index.ts']);
  }
});

test('真实 OpenAI 适配器复现默认 none，并验证会话档位写入请求体', async () => {
  const actualModel = {
    ...model, id: 'gpt-6-astra', api: 'openai-responses', baseUrl: 'https://example.invalid/v1',
    reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
  };
  let payload;
  const onPayload = value => { payload = value; throw new Error('已捕获请求，禁止联网'); };
  const oldResponse = await stream(actualModel, { messages: [] }, { apiKey: '测试凭据', onPayload }).result();
  assert.match(oldResponse.errorMessage, /已捕获请求/);
  assert.equal(payload.reasoning.effort, 'none');
  for (const thinking of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const ctx = context();
    ctx.model = actualModel;
    ctx.thinkingLevel = thinking;
    ctx.modelRegistry.getProvider = () => ({
      streamSimple: (requestModel, prompt, options) => streamSimple(requestModel, prompt, { ...options, onPayload }),
    });
    await assert.rejects(generateCommitMessage(ctx, 'diff', ['index.ts']), /已捕获请求/);
    assert.equal(payload.reasoning.effort, thinking);
  }
});

test('提供方或认证缺失时停止生成', async () => {
  const ctx = context(() => { assert.fail('不应请求模型'); });
  ctx.modelRegistry.getProviderAuth = async () => undefined;
  await assert.rejects(generateCommitMessage(ctx, 'diff', []), /认证未配置/);
  ctx.modelRegistry.getProvider = () => undefined;
  await assert.rejects(generateCommitMessage(ctx, 'diff', []), /提供方不可用/);
});

test('拒绝空结果、异常完成、截断、非法格式和通用文案', async () => {
  for (const result of [response(''), response('fix: 修复残留', 'error'), response('fix: 修复残留', 'length'), response('说明文字'), response('chore(GameClient): 更新代码与相关配置')]) {
    await assert.rejects(generateCommitMessage(context(async () => result), 'diff', ['角色.cs']));
  }
  await assert.rejects(generateCommitMessage(context(async () => { throw new Error('认证失败'); }), 'diff', []), /认证失败/);
  await assert.rejects(generateCommitMessage({ modelRegistry: {} }, 'diff', []), /未选择模型/);
});

test('生成失败不提交或推送，文件清单仅包含暂存区', async () => {
  const repo = join(root, 'repo');
  await mkdir(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', '测试');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, '角色 文件.cs'), '初始内容');
  await writeFile(join(repo, '未暂存.cs'), '初始内容');
  git('add', '.');
  git('commit', '-qm', 'test: 初始化');
  const head = git('rev-parse', 'HEAD');
  await writeFile(join(repo, '角色 文件.cs'), '修改内容');
  await writeFile(join(repo, '未暂存.cs'), '不应包含在提交中');
  git('add', '--', '角色 文件.cs');
  assert.deepEqual(await getStagedFiles(repo), ['角色 文件.cs']);
  const commands = new Map();
  const messages = [];
  register({
    registerCommand: (name, command) => commands.set(name, command),
    sendMessage: message => messages.push(message),
    getThinkingLevel: () => 'max',
  });
  const ctx = { ...context(async () => { throw new Error('认证失败'); }), cwd: repo, hasUI: true, ui: { notify() {} } };
  await commands.get('commit-push').handler('', ctx);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.match(messages.at(-1).content, /未执行提交或推送/);
  assert.match(messages.at(-1).content, /认证失败/);
  assert.deepEqual(await getStagedFiles(repo), ['角色 文件.cs']);
  // 兼容尚未提供 ctx.thinkingLevel 的宿主，从公开会话接口获取实际档位。
  delete ctx.thinkingLevel;
  ctx.modelRegistry = context(async (_model, _prompt, options) => {
    assert.equal(options.reasoning, 'max');
    return response('fix: 修复角色表现');
  }).modelRegistry;
  await commands.get('commit').handler('', ctx);
  assert.equal(git('log', '-1', '--format=%B'), 'fix: 修复角色表现');
  assert.notEqual(git('rev-parse', 'HEAD'), head);
  assert.ok(git('diff', '--name-only', '-z').includes('未暂存.cs'));
});
