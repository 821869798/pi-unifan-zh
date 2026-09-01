# pi-review reference

Design references and version planning. Read these before changing pipeline shape, reviewer roster, or gate behavior so we do not drift from agreed intent.

| Document | Contents |
|----------|----------|
| [claude-code-review.md](./claude-code-review.md) | Official Claude `/code-review` pipeline (source of truth: `commands/code-review.md`) |
| [cursor-review-skills.md](./cursor-review-skills.md) | Cursor Bugbot / Security Review skills (what to borrow, what not to) |
| [pi-review-roadmap.md](./pi-review-roadmap.md) | pi-review adaptation, phase mapping, version plan |
| [v0.2-plan.md](./v0.2-plan.md) | **v0.2.0 task list**, acceptance criteria, implementation order |
| [structured-output.md](./structured-output.md) | Child capture extension env contract |

**Primary upstream (Claude):**  
https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-review/commands/code-review.md

**When to update this folder**

- Upstream Claude command changes
- Reviewer roster or pipeline phase changes in pi-review
- Default threshold / gate semantics change
