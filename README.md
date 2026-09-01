# 🌟 pi-unifan-zh (Pi 中文扩展与工具库)

专为 **Pi Coding Agent** 设计的高质量中文扩展合集与独立插件库。

支持 **“全家桶一键整包安装”** 与 **“按需单个插件独立安装”** 双模式架构。

---

## 📁 项目目录结构

```text
pi-unifan-zh/
├── package.json              # 根包配置（支持整包一键安装）
├── tsconfig.json             # TypeScript 编译配置
├── .gitignore                # Git 忽略规则
├── README.md                 # 仓库主说明文档
├── extensions/               # 📦 独立插件集目录
│   └── sessions/             # 📜 历史会话管理器（双栏实时预览与恢复·中文增强版）
│       ├── package.json      # 独立包配置（支持单独发布与单独安装）
│       ├── index.ts          # TUI 交互与命令逻辑
│       ├── sessions.ts       # 会话数据提取与格式化
│       └── README.md         # 插件独立使用说明
└── skills/                   # 🎯 自定义技能目录（存放自定义 SKILL.md）
    └── README.md
```

---

## 🚀 安装指南

### 模式 A：一键安装整包（包含库内所有插件与技能）

#### 1. 远程一键安装（推荐）：
```bash
pi install git:github.com/821869798/pi-unifan-zh
```

#### 2. 本地安装测试：
```bash
pi install D:/program/my/pi-unifan-zh
```

---

### 模式 B：按需单独安装单个插件

每个插件都位于 `extensions/<插件名>/` 下，并自带独立的 `package.json`，支持独立安装与卸载：

#### 仅安装 `sessions` 历史会话管理器：
```bash
pi install D:/program/my/pi-unifan-zh/extensions/sessions
```

---

## 📦 已包含的扩展清单

### 1. 📜 `sessions`（历史会话管理器·中文版）
- **命令**：`/sessions`
- **特性**：
  - 双栏全屏 TUI 视图（左侧选会话与 Git 变更统计，右侧毫秒级实时滚屏预览完整对话）。
  - 支持 `◆ 用户`、`● 助手`、`◌ 思考过程`、`▸ 工具调用` 与折叠。
  - 界面与时间提示（刚刚/X分钟前/昨天）全面中文化。
  - 独立运行，零多余 Token 消耗，不引发卡顿。

---

## 🛠️ 后续如何开发新插件？

1. 在 `extensions/` 目录下新建一个插件文件夹（例如 `extensions/my-tool/`）。
2. 在该文件夹内创建 `package.json` 和 `index.ts`。
3. 在根目录的 `package.json` 中的 `"pi"."extensions"` 数组添加新入口：
   ```json
   "pi": {
     "extensions": [
       "./extensions/sessions/index.ts",
       "./extensions/my-tool/index.ts"
     ]
   }
   ```
4. 运行 `pi reload` 即可自动生效！

---

## 📄 开源协议

MIT License