# 🎯 Pi Skills 目录 (自定义技能库)

此目录用于存放你自定义的 Pi Agent Skills。

---

## 🛠️ 如何添加一个新 Skill？

每个 Skill 是一个单独的文件夹，包含一个核心的 `SKILL.md`：

```text
skills/
└── my-unity-helper/
    └── SKILL.md
```

### `SKILL.md` 格式规范：
```markdown
---
name: my-unity-helper
description: 专门用于处理 Unity C# 业务逻辑与性能优化的自定义技能
---

# 指令与规则
1. 异步编程一律使用 UniTask。
2. 避免在 Update 中进行任何 GC 堆内存分配。
```

当安装本仓库后，Pi 会自动发现并加载此目录下的所有 Skill。