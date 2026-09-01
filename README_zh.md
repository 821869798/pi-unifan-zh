# 🌟 pi-unifan-zh (Pi 中文扩展全家桶与独立插件库)

专为 **Pi Coding Agent** 打造的高质量中文扩展合集与独立插件库。

支持 **“全家桶一键整包安装”** 与 **“按需单个插件独立安装”** 双模式架构。

---

## 📁 目录结构

```text
pi-unifan-zh/
├── package.json              # 根包配置（支持整包一键安装）
├── tsconfig.json             # TypeScript 配置
├── README.md                 # English Documentation
├── README_zh.md              # 中文说明文档
├── extensions/               # 📦 独立插件集
│   ├── sessions/             # 📜 历史会话管理器（双栏实时预览与恢复·中文增强版）
│   └── review/               # 🔍 AI 并发代码审查（5 专家并发 + 门禁裁判·中文增强版）
└── skills/                   # 🎯 自定义技能库（存放自定义 SKILL.md）
```

---

## 🚀 安装指南

### 模式 A：一键安装整包（包含所有插件与技能）

#### 1. 通过 npm 在线安装：
```bash
pi install npm:@unifan/pi-unifan-zh
```

#### 2. 通过 GitHub 远程在线安装（实时最新）：
```bash
pi install git:github.com/821869798/pi-unifan-zh
```

#### 3. 本地开发调试安装：
```bash
pi install D:/program/my/pi-unifan-zh
```

---

### 模式 B：按需单独安装单个插件

#### 1. 仅安装 `sessions`（历史会话管理器·中文版）：
```bash
# npm 在线安装：
pi install npm:@unifan/pi-sessions-zh

# 本地安装：
pi install D:/program/my/pi-unifan-zh/extensions/sessions
```

#### 2. 仅安装 `review`（AI 并发代码审查·中文版）：
```bash
# npm 在线安装：
pi install npm:@unifan/pi-review-zh

# 本地安装：
pi install D:/program/my/pi-unifan-zh/extensions/review
```

---

## 📦 扩展功能与使用说明

### 1. 📜 `sessions`（历史会话管理器·中文版）
- **命令**：`/sessions`
- **特性**：
  - 双栏全屏 TUI 视图（左侧选会话与 Git 变更统计，右侧毫秒级实时滚屏预览完整对话）。
  - 支持 `◆ 用户`、`● 助手`、`◌ 思考过程`、`▸ 工具调用` 与折叠。
  - 界面与时间提示（刚刚/X分钟前/昨天）全面中文化。
  - 零多余 Token 消耗，纯净轻快。
- **快捷键**：
  - `Enter`：一键恢复并切换到所选会话。
  - `t`：展开/折叠工具输出。
  - `h`：展开/隐藏思考过程。
  - `Tab`：切换左右面板焦点。
  - `PgUp` / `PgDn`：预览窗滚屏翻页。
  - `Ctrl+T` / `Alt+W`：切换全部工作区/仅当前项目。
  - `Esc`：退出选择器。

---

### 2. 🔍 `review`（AI 并发代码审查·中文版）
- **命令**：
  - **`/review --lite`** ⭐ **（极速单兵审查，强烈推荐日常使用）**：单 AI 快速体检，3~5 秒出结果，极度省时省 Token。
  - **`/review`**：全量 5 专家深度并发审查 + 门禁裁判长综合判定（适合重大 PR 与版本合并）。
  - **`/review 重点看并发与内存泄露`**：带侧重点定向深度审查。
  - **`/review-show`**：重新查看最近一次的代码审查报告。
  - **`/review-agents`**：查看各专家代理状态与模型分配。
  - **`/review-config`**：编辑审查配置文件。
- **特性**：
  - 5 大专业 AI 专家（Bug 猎手、安全审查官、规范守卫、历史回归分析官、注释审查官）并发排查。
  - 门禁裁判长（Gate AI）智能去重并过滤置信度低于 8 分的误报。
  - **报告与问题描述 100% 纯正中文输出**，严重等级分类（致命阻断 / 严重 / 次要 / 细节优化）。

---

## 🔄 后续如何更新？

```bash
# 更新全部已安装的扩展：
pi update --extensions

# 或指定更新某个插件：
pi update npm:@unifan/pi-unifan-zh
pi update git:github.com/821869798/pi-unifan-zh
```

---

## 📄 开源协议

MIT License