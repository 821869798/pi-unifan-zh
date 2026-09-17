---
name: 03-work
description: "严格 TDD 编码执行与断点续跑。按 Plan 中的 Implementation Units 逐一实现代码与测试，支持断点自动恢复与遇错即停。"
---

# 03-work: 严格 TDD 编码执行与断点续跑

当计划制定完毕后（已有 `docs/plans/`），使用本技能进入实际代码编写阶段。

## 核心工程纪律

1. **断点恢复机制 (Session Checkpoint)**：
   - 每次启动时，调用 `session_checkpoint({ operation: "load", planPath: "..." })` 检查历史进度。
   - **绝不重复执行已完成的单元**，直接从第一个未完成的 Unit 恢复推进。
2. **严格 TDD (红-绿-重构)**：
   - 编写或调整对应的测试用例。
   - 实现让测试通过的最简代码。
   - 运行测试套件，确认通过。
3. **Stop-the-line (遇错即停硬门禁)**：
   - 一旦测试失败或发生未预期的异常：
     1. **立即停止** 添加后续功能代码。
     2. **保留现场**，不要盲目乱改代码碰运气。
     3. **诊断根因**，修复真正诱因并复测。
     4. 若无法自动修复，调用 `session_checkpoint({ operation: "fail" })` 并向用户如实报告。
4. **单元提交与保存**：
   - 每完成一个 Unit 且测试 100% 绿灯后，调用 `session_checkpoint({ operation: "save", completedUnits: [...] })` 记录进度。

## 循环推进流程

```
[检查断点] ──> [选取待办 Unit] ──> [编写/更新测试]
                                          │
                                          ▼
[保存断点] <── [测试通过 Green] <── [编写业务代码]
     │
     ▼
(还有未办 Unit?) ──> 是: 循环下一个
                 └── 否: 全部完成，进入 04-review
```

1. **启动检测**：
   - 确认输入的 `plan.md` 路径，读取其中的 Units 清单。
   - 读取断点文件，输出进度（例如：`当前已完成 2/5 单元，从 Unit 3 开始执行`）。
2. **单单元推进**：
   - 对当前 Unit 涉及的文件执行写入/修改。
   - 运行终端测试命令（如 `npm test` 或运行具体测试文件）。
   - 测试通过后，调用 `session_checkpoint({ operation: "save", completedUnits: ["Unit X"] })`。
3. **完成闭环**：
   - 当所有 Units 均执行并通过测试后，向用户汇报执行摘要。
   - 提示下一步推荐：运行 `/skill:04-review` 进行质量审查与回归验证。
