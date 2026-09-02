# 🔍 @unifan/pi-review-zh (AI 并发代码审查·中文增强版)

专为 **Pi Coding Agent** 打造的多专家子代理并发审查与门禁裁判系统（移植自 Claude Code 官方高级代码审查架构并全面中文化）。

---

## ✨ 核心特性

- **5+1 多专家并发架构**：
  - `bugbot`（Bug 猎手：专查逻辑死循环、空指针、竞态与边界异常）
  - `security-review`（安全审查官：专查注入漏洞、数据泄露与敏感信息）
  - `claude-md-compliance`（规范守卫：审查代码与 `AGENTS.md` 规则的合规性）
  - `history-context`（历史回归分析官：对比 Git 历史排查潜在退化）
  - `code-comments`（注释与规范审查：检查遗留 TODO 与注释有效性）
  - `gate`（**门禁裁判长**：汇总多专家发现，智能去重、误报过滤与最终裁决）
- **高信噪比与防误报**：自带门禁裁判打分机制，自动剔除置信度低于 8 分的无效警报。
- **全中文交互与报告**：审查卡片、严重级别分类（致命阻断/严重/次要/细节优化）、裁判理由全面中文化呈现。
- **支持极速省 Token 模式**：通过 `--lite` 开启单兵轻量快速体检。

---

## 🎮 使用方法

### 1. 全量 5 专家深度审查
```text
/review
```
自动分析当前工作区未提交的修改，5 个专家并发审查并由门禁长给出裁决。

### 2. 极速单专家审查 (日常快速体检，极度省 Token)
```text
/review --lite
```

### 3. 带侧重点定制审查
```text
/review 重点帮我审查并发安全和内存泄漏
```

### 4. 重新查看上次报告 / 查看专家列表
```text
/review-show     # 重新显示最近一次审查报告
/review-agents   # 查看各专家代理状态与模型分配
/review-config   # 编辑配置文件 (~/.pi/agent/pi-review.json)
```

---

## 🚀 安装方式

### 独立单独安装：
```bash
pi install D:/program/my/pi-unifan-zh/extensions/review
```
*(或者整包一键安装：`pi install git:github.com/821869798/pi-unifan-zh`)*