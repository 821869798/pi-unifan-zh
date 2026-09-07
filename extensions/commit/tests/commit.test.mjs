import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

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
function context(complete) { return { model, modelRegistry: { complete } }; }
function response(text, stopReason = 'stop') { return { content: [{ type: 'text', text }], stopReason }; }

test('通过宿主统一接口继承当前模型并返回业务日志', async () => {
  const ctx = context(async (actualModel, prompt, options) => {
    assert.equal(actualModel, model);
    assert.match(prompt.messages[0].content[0].text, /修复冲线残留/);
    assert.equal(options.maxTokens, 4096);
    return response('```text\nfix(racing): 清理冲线特效残留\n```');
  });
  assert.equal(await generateCommitMessage(ctx, '+ 清理特效', ['角色.cs'], '修复冲线残留'), 'fix(racing): 清理冲线特效残留');
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
  register({ registerCommand: (name, command) => commands.set(name, command), sendMessage: message => messages.push(message) });
  const ctx = { ...context(async () => { throw new Error('认证失败'); }), cwd: repo, hasUI: true, ui: { notify() {} } };
  await commands.get('commit-push').handler('', ctx);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.match(messages.at(-1).content, /未执行提交或推送/);
  assert.match(messages.at(-1).content, /认证失败/);
  assert.deepEqual(await getStagedFiles(repo), ['角色 文件.cs']);
  ctx.modelRegistry.complete = async () => response('fix: 修复角色表现');
  await commands.get('commit').handler('', ctx);
  assert.equal(git('log', '-1', '--format=%B'), 'fix: 修复角色表现');
  assert.notEqual(git('rev-parse', 'HEAD'), head);
  assert.ok(git('diff', '--name-only', '-z').includes('未暂存.cs'));
});
