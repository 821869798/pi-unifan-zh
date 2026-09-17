---
name: 02-plan
description: "架构设计与细粒度 TDD 执行计划。吸收工业级架构规范，定义状态归属与分层依赖，将需求拆解为带确定性验收命令的 Implementation Units。"
---

# 02-plan: 架构设计与 TDD 执行计划

在需求确定后（已有 `docs/brainstorms/`），使用本技能制定清晰、细粒度且具备测试门禁的实施方案。
本技能拒绝输出泛泛而谈的伪计划，必须将架构推演到**文件落点与确定性验收命令**级别。

## 核心架构原则

1. **80% 设计，20% 编码**：动笔写业务代码前，把分层、接口签名、状态事实归属与测试契约确定好。
2. **极简主义阶梯 (The Ladder)**：
   - 能用标准库解决的，绝不引入第三方库。
   - 优先复用项目中已有的模式与工具。
3. **状态事实归属明确 (State Ownership)**：
   - 明确划分“内部事实由谁拥有，外部事实由谁拥有”。上层绝不越权猜测下层状态，一律通过标准接口或事件通道通讯。
4. **单向无环依赖 (Acyclic Dependencies)**：
   - 底层核心不依赖上层 UI，依赖方向严格朝下，严禁循环引用。

## 执行计划文档必须包含的 4 大板块

调用 `artifact_helper({ repoRoot: ".", artifactType: "plan", topic: "<topic-name>", ensureDir: true })` 获取路径，写入 `docs/plans/YYYY-MM-DD-<topic>-plan.md`：

### 1. 架构总览与模块落点 (Architecture & Module Blueprint)
- **分层图与职责清晰划分**：各模块/crate 的职责与禁止依赖的边界。
- **具体文件落点规划**：列出每个模块的核心文件路径与类/函数意图（不堆单文件上帝对象）。

### 2. 状态归属与核心契约 (State Ownership & Contracts)
- 核心数据模型、生命周期所有权、线程/异步通信模型（如事件通道、通道无阻塞传输）。

### 3. 未验证前提与风险探针 (Spike & Preconditions)
- 是否有未经验证的第三方 API、平台权限或环境假设？标记在开工前必须探针验证的事项。

### 4. Implementation Units 实现单元拆解（可执行的进度清单）
将整个工程拆分为按序推进的 **Unit 0, Unit 1, Unit 2 ...**：
每一个 Unit 必须严格包含以下 4 项要素：
- **目标 (Goal)**：本单元具体实现哪一个清晰独立的切片。
- **人能看到/做到什么 (User Visible Outcome)**：执行完本单元后，人类或测试用例肉眼能验证什么现象。
- **涉及文件清单 (Files Touched)**：明确新建或修改的具体文件路径。
- **确定性验收命令 (Deterministic Verification Commands - 极其关键)**：
  - 必须写出具体的终端命令（如 `cargo test -p xxx`、`npm run typecheck`、`node --test ...`）。
  - 只有当该命令**完全绿灯（0 失败、0 告警）**时，本单元才允许判定为完成。

## 流程结语
向用户展示架构计划大纲，并提示下一步推荐：运行 `/skill:03-work docs/plans/...` 启动严格 TDD 编码与断点推进。
