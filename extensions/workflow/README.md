# 🔄 @unifan/pi-workflow-zh (复合工程工作流引擎·中文版)

专为 **Pi Coding Agent** 打造的复合工程工作流（Compound Engineering）引擎扩展。提供状态自动感知、执行断点持久化与长输出智能压缩。

---

## ✨ 核心特性

- **工作流状态感知**：自动识别项目当前处于需求、计划、编码还是复盘阶段，提供智能下一步建议。
- **执行断点恢复（Checkpoints）**：以 Implementation Unit 为粒度持久化执行状态，支持中断后无缝续跑。
- **产物目录标准化**：自动规范化 `docs/brainstorms/`、`docs/plans/`、`docs/solutions/` 与 `.context/checkpoints/`。
- **上下文 Token 压缩器**：内置 `bash` 与 `read` 智能过滤器，过滤冗余日志与超大 Lockfile，节省 80%+ Token。
- **与现代终端问答联动**：无缝协同 `@juicesharp/rpiv-ask-user-question` 终端多选/单选/自由输入组件。

---

## 🚀 安装方式

### 1. 从 npm 在线安装：
```bash
pi install npm:@unifan/pi-workflow-zh
```

### 2. 本地路径单独安装：
```bash
pi install D:/program/my/pi-unifan-zh/extensions/workflow
```

> **提示**：若需要终端弹窗多选复选框等高级问答交互，建议搭配安装：
> ```bash
> pi install npm:@juicesharp/rpiv-ask-user-question
> ```

---

## 🎮 使用方法

在 Pi 中输入命令查看工作流看板：
```text
/workflow
```
可查看当前项目工作流阶段状态、已归档产物清单与 03-work 自主循环进度。

### 6 大内置复合工程技能
- **`/skill:00-next`**：智能进度分析与路由推荐
- **`/skill:01-brainstorm`**：需求发现与边界澄清
- **`/skill:02-plan`**：TDD 架构规划与 Implementation Units 拆解
- **`/skill:03-work`** 🚀：**自主循环干活（不做完不停机）**。按计划顺序跨回合自动推进所有单元，完成全部规划前绝不停机，中途可随时输入“暂停”或按 Esc 挂起。
- **`/skill:04-review`**：全量代码审查与回归验证
- **`/skill:05-learn`**：极简疑难避坑卡片沉淀
