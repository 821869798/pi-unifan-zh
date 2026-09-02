# 📖 Pi Unifan 中文扩展套件开发与发布指南 (AGENTS.md)

> 本文档面向所有参与 `@unifan/pi-unifan-zh` 项目开发、维护与发版的 AI 智能体（Agents）及开发者。修改代码或发布版本前必须严格遵守本文档所列出的规范与铁律。

---

## 🏗️ 一、项目架构与包结构

本项目是一个 Monorepo 架构的 Pi Coding Agent 中文扩展全家桶，包含 3 大核心扩展与技能库：

```text
pi-unifan-zh/
├── package.json                   # 聚合主包: @unifan/pi-unifan-zh
├── AGENTS.md                      # 本开发与维护规范指南
├── README_zh.md                   # 中文用户使用手册
├── extensions/
│   ├── sessions/                  # ① 会话管理扩展 (/sessions)
│   │   ├── index.ts               # 双栏实时预览 TUI 交互逻辑
│   │   ├── sessions.ts            # 会话解析、时间格式化与搜索过滤
│   │   └── package.json
│   ├── review/                    # ② 代码审查全能扩展 (/review, /review-lite, /review-perf, /review-full)
│   │   ├── index.ts               # 斜杠命令注册与自动补全
│   │   ├── agents/                # 独立子代理提示词 (UTF-8 无 BOM)
│   │   │   ├── bugbot.md          # 逻辑缺陷专家
│   │   │   ├── security-review.md # 安全隐患专家
│   │   │   ├── lite-review.md     # 极速单兵审查官
│   │   │   ├── perf-review.md     # 性能与基准测试专家
│   │   │   ├── gate.md            # 门禁裁判长仲裁模型
│   │   │   ├── claude-md-compliance.md # 规范合规专家
│   │   │   ├── history-context.md # 历史上下文专家
│   │   │   └── code-comments.md   # 注释检查专家
│   │   ├── src/
│   │   │   ├── directive.ts       # 工作流脚本生成 (带自动重试与容错)
│   │   │   ├── review-run.ts      # 运行编排与路由分发
│   │   │   ├── report.ts          # 报告拼装与 Markdown 渲染
│   │   │   └── config.ts          # 默认配置 (门禁模型继承 inherit)
│   │   └── package.json           # 独立子包: @unifan/pi-review-zh
│   └── commit/                    # ③ 智能 Git 提交助手 (/commit, /commit-push)
│       ├── index.ts               # 一键提交与推流命令
│       ├── src/
│       │   ├── git.ts             # Git 执行引擎 (含自动变基 pull --rebase)
│       │   └── prompt.ts          # Conventional Commits 中文提示词
│       └── package.json           # 独立子包: @unifan/pi-commit-zh
└── skills/                        # 内置专业技能集
```

---

## 🛡️ 二、开发规范与核心铁律（Hard Rules）

参与本仓库开发时，**必须严格遵守以下 5 条铁律**：

### 1. 纯正中文语言约束（Strict Chinese Output）
* 所有面向用户的 UI 交互、待办清单（Checklist）、状态通知（Notify）、错误提示、TUI 卡片以及 Subagent 的 System Prompt，**必须 100% 使用纯正中文**。
* 严禁夹杂未经翻译的英文模板或生硬机翻长句。

### 2. Windows 环境 UTF-8 严禁带 BOM（Zero UTF-8 BOM Rule）
* **背景**：Windows PowerShell 默认的 `[System.Text.Encoding]::UTF8` 会写入 3 字节的 BOM 头（`0xEF 0xBB 0xBF`），这会导致 Pi 的 YAML Frontmatter 解析器失效，将所有 Subagent 识别为未知代理。
* **规则**：生成或修改任何 `.md`、`.ts`、`.json` 文件时，**必须显式使用无 BOM 的 UTF-8 编码**：
  ```powershell
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($filePath, $content, $utf8NoBom)
  ```

### 3. 模型自适应继承（Model Inheritance & No Hardcoding）
* **严禁硬编码特定模型**：Subagent 与门禁裁判长（Gate）的默认模型必须设置为 `"inherit"`，以自动跟随用户主会话所使用的模型（如 Gemini、OpenAI、Claude、DeepSeek、代理渠道等）。
* **严禁硬编码 `thinking: "low"`**：部分模型不支持分档思考，强制注入 `"low"` 会导致 `pi-subagents` 抛出 `No usable subagent models remain` 错误。

### 4. Git 提交信息标准（Conventional Commits 1.0.0）
* **格式**：`<type>(<scope>): <中文描述>` 或 `<type>: <中文描述>`
* **标点约束**：括号 `()` 与冒号空格 `: ` **必须严格使用半角英文符号**（严禁全角符号，以保证 CI / Commitlint 正则解析）。
* **严禁 Emoji**：保持严肃、专业的纯文本工程风格。
* **11 大标准分类**：
  * `feat`: 新增功能/新模块
  * `fix`: 修复Bug/缺陷
  * `perf`: 性能优化/降低GC/提高帧率
  * `refactor`: 代码重构
  * `ci`: CI/CD持续集成与工作流
  * `build`: 构建系统与依赖包
  * `chore`: 杂项与版本升级（如 `chore(release): 升级版本号至 vX.Y.Z`）
  * `docs`: 文档/注释
  * `test`: 单元测试/基准测试
  * `style`: 代码格式调整
  * `revert`: 代码回滚

### 5. 多 Agent 容错与重试保护（Fault Tolerance）
* **网络抖动重试**：`runs.all` 并发调用必须包裹 `try-catch` 并在发生网络断连时自动延迟 800ms 重试一次。
* **门禁熔断保护**：门禁裁判长（Gate）发生异常时必须兜底捕获，**绝对不能抛出未捕获异常导致已完成的 Reviewer 成果丢失**。

### 6. 冲突解决原则
拉取或变基冲突时，严禁直接使用 ours/theirs 覆盖，必须根据双方修改对比与上下文解决冲突。

---

## 🚀 三、发版与发布指南（Release & Publish Workflow）

当完成功能开发、修复或提示词更新后，严格按照以下步骤完成发版：

### 1. 本地代码检查与 BOM 修复
```powershell
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
Get-ChildItem -Path "D:\program\my\pi-unifan-zh" -Recurse -Include "*.md","*.ts","*.json" | ForEach-Object {
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $content = [System.IO.File]::ReadAllText($_.FullName)
        if ($content.StartsWith([char]0xFEFF)) { $content = $content.Substring(1) }
        [System.IO.File]::WriteAllText($_.FullName, $content, $utf8NoBom)
    }
}
```

### 2. Git 提交业务改动
```bash
git add .
git commit -m "feat(xxx): 描述本次修改内容"
git push origin main
```

### 3. npm Monorepo 批量版本升级与发布
```powershell
# 1. 升级并发布根主包 (@unifan/pi-unifan-zh)
cd D:\program\my\pi-unifan-zh
npm version patch
npm publish --access public

# 2. 升级并发布 review 子包 (@unifan/pi-review-zh)（如有修改）
cd D:\program\my\pi-unifan-zh\extensions\review
npm version patch
npm publish --access public

# 3. 升级并发布 commit 子包 (@unifan/pi-commit-zh)（如有修改）
cd D:\program\my\pi-unifan-zh\extensions\commit
npm version patch
npm publish --access public

# 4. 提交版本号变更到 Git 远端
cd D:\program\my\pi-unifan-zh
git add .
git commit -m "chore(release): 升级版本号至 vX.Y.Z"
git push origin main
```

### 4. 本地环境即时同步验证
发布成功后，在本地 Pi 环境中执行更新命令，验证最新功能：
```bash
pi update npm:@unifan/pi-unifan-zh
```

---

## ⌨️ 四、常用测试与验证命令

```bash
# 测试会话管理器
/sessions

# 测试极速代码审查
/review-lite

# 测试性能专项审查
/review-perf

# 测试日常代码审查 (3专家)
/review

# 测试全量深度审查 (6专家)
/review-full

# 测试智能代码提交
/commit

# 测试智能提交并自动推流
/commit-push
```