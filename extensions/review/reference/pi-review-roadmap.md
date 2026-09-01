# pi-review — design & version roadmap

> **Positioning:** Pure **skills** extension — user manually runs `/review`. No harness, no auto-fix, no GitHub bot in v1.  
> **Pattern:** Claude code-review **pipeline shape** + Cursor **bug/security prompt discipline**.  
> **See also:** [claude-code-review.md](./claude-code-review.md), [cursor-review-skills.md](./cursor-review-skills.md)

Last updated: 2026-07-19.

## Design principles

1. **Pipeline, not a bag of agents** — eligibility → prep → parallel content → score/filter → output.
2. **High signal** — default threshold aligned with Claude’s 80/100 (our **8/10**).
3. **Local-first** — `git diff` / diff file; no `gh` required in v1.
4. **Manual invocation only** — no `registerTool`, no CI hooks in v1.
5. **Gate = Phase 4+5 compression** — one cheap spawn for dedupe + re-score + verdict; optional per-issue scorers in a later version.

## Phase mapping (Claude → pi-review)

| Claude phase | pi-review module (planned) | v1 behavior |
|--------------|----------------------------|-------------|
| **0 Eligibility** | `src/eligibility.ts` | Empty diff, non-git, optional trivial skip |
| **1 Prep** | `src/prep.ts` | Rule paths (`AGENTS.md`, `CLAUDE.md`, `.pi/`) + diff summary injected into reviewer task |
| **2 Content (×5)** | `src/review.ts` + `agents/*.md` | Parallel subagents; bundled prompts as `--system-prompt` |
| **3 Score + filter** | `src/gate.ts` + `prompts/gate.md` | Dedupe, apply Claude rubric (adapted to 1–10), threshold, verdict |
| **4 Re-check** | `index.ts` | Optional: re-verify diff non-empty before render |
| **5 Output** | `src/report.ts` | `sendMessage` + `appendEntry("pi-review", …)` |

```text
/review
  │
  ├─ Phase 0  eligibility()          → notify + exit if skip
  ├─ Phase 1  resolveDiff()            → git-input / path / @file
  ├─ Phase 1  prepareContext()         → rule paths + summary (sync or 1 cheap spawn)
  ├─ Phase 2  runReviewers()           → 5 parallel (cap 4 concurrency → 2 waves)
  ├─ Phase 3  runGate()                → unless --no-gate
  └─ Phase 4  buildReport + render     → TUI markdown
```

## Default reviewer roster (v0.2 target)

Aligned to Claude’s five content agents, adapted for local use:

| ID | Claude agent | Status | Tools (default) |
|----|--------------|--------|-----------------|
| `claude-md-compliance` | #1 CLAUDE.md | exists | read, grep, find, ls |
| `bugbot` | #2 Bug detector | rename `bug-detector` | read, grep, find |
| `history-context` | #3 History | exists | read, bash |
| `security-review` | *(pi addition)* | **new** | read, grep, find |
| `code-comments` | #5 Code comments | **new** | read, grep |

**Dropped / deferred**

| ID | Reason |
|----|--------|
| `pr-context` (Claude #4) | Requires `gh` + PR metadata — **v1 out of scope** |
| `conventions` | Overlaps compliance + Claude false-positive list; keep as **optional** `enabled: false` |

**Concurrency:** hard cap 4 → five reviewers run as batch of 4 + batch of 1 (or user passes `--reviewer` subset).

## Confidence scale

| System | Scale | Default keep |
|--------|-------|--------------|
| Claude Phase 4 | 0–100 | ≥ 80 |
| pi-review reviewer + gate | 1–10 | ≥ **8** (change default from 3) |

Gate prompt must embed Claude’s rubric (translated to 1–10) for **re-scoring**, not only filtering reviewer self-reported confidence.

## Known gaps (v0.1.0 codebase)

| Gap | Blocks |
|-----|--------|
| Missing `index.ts` | Extension load |
| `agents/*.md` not used as system prompt | Reviewer quality |
| `PI_SUBAGENT_STRUCTURED_OUTPUT_*` not handled by stock `pi` | Subagent spawn |
| No eligibility / prep phases | Claude alignment |
| Default threshold 3 | Too noisy vs Claude |

## Version plan

### v0.1.0 — current (incomplete)

**Shipped:** core libs, 4 agent templates, gate schema, tests (92).  
**Not shipped:** `index.ts`, npm publish, end-to-end run.

No further work on 0.1.0 except tagging reality in CHANGELOG if needed.

---

### v0.2.0 — “skills MVP” (target)

**Goal:** User can `pi -e .` or install package and run `/review` on local diff with Claude-shaped pipeline.

| Work item | Priority |
|-----------|----------|
| `index.ts` — `/review`, `/review-config`, `/review-agents` | P0 |
| `src/structured-output-capture.ts` — minimal child extension OR document `-e` flag for structured output | P0 |
| Wire `agents/<id>.md` + `prompts/gate.md` as system prompts | P0 |
| `src/eligibility.ts` — empty diff, non-git, trivial diff heuristic | P0 |
| `src/prep.ts` — rule file paths + diff summary in task preamble | P1 |
| Rename `bug-detector` → `bugbot`; add `security-review.md`, `code-comments.md` | P1 |
| Default threshold **8**; gate prompt Claude rubric | P1 |
| `conventions` default `enabled: false` | P2 |
| Update README + CHANGELOG | P1 |
| `reference/` in package `files` | P1 |

**Out of scope v0.2:** `gh`, per-issue scorers, `registerTool`, worktree, retry loop.

**Implementation:** see [v0.2-plan.md](./v0.2-plan.md) for the full task list (54 tasks, 7 tracks).

**Exit criteria**

- [ ] `pi -e /path/to/pi-review` → `/review` on dirty repo produces report
- [ ] Gate drops low-confidence issues; empty high-confidence → clear message
- [ ] `bun test` + `bun run check` pass
- [ ] npm publish `@georgedong32/pi-review@0.2.0`

---

### v0.3.0 — “quality & optional GH”

| Work item | Notes |
|-----------|-------|
| Per-issue scorer mode (`--score-per-issue`) | True Claude Phase 4; higher cost |
| `pr-context` reviewer (optional) | Behind `gh` detection + config flag |
| Reviewer failure retry (1×) | Only on spawn/timeout errors |
| `registerMessageRenderer` for collapsible report | TUI polish |
| Eligibility: “already reviewed” via session `appendEntry` hash | Optional |

---

### v1.0.0 — stable API

- Frozen config schema v1
- Documented reviewer add/replace contract
- Published pi gallery entry
- No breaking changes without `schemaVersion` bump

## File layout (target)

```text
index.ts                      Extension entry
src/
  eligibility.ts              Phase 0
  prep.ts                     Phase 1
  git-input.ts                Diff resolution (existing)
  review.ts                   Phase 2 fan-out (existing)
  gate.ts                     Phase 3 (existing)
  report.ts                   Phase 5 output (existing)
  structured-output-capture.ts  Child pi extension for spawn (new)
agents/
  claude-md-compliance.md
  bugbot.md                     (was bug-detector)
  history-context.md
  security-review.md            (new)
  code-comments.md              (new)
  conventions.md                (optional, disabled)
prompts/
  gate.md
reference/                      This folder
```

## Commands (unchanged UX)

```text
/review [path | @path] [--threshold N] [--reviewer id ...] [--no-gate] [--gate-model id] [--no-spawn]
/review-config
/review-agents
```

## Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-19 | Pure skills, manual `/review` only | User intent; avoid harness scope |
| 2026-07-19 | Follow Claude **pipeline**, not just parallel agents | User correction; command file is SoT |
| 2026-07-19 | Keep `history-context` in default roster | Claude agent #3; not merged into bugbot |
| 2026-07-19 | Add `security-review` (Cursor-inspired) | Orthogonal to bug + compliance |
| 2026-07-19 | Gate compresses Phase 4+5 for v0.2 | Cost vs fidelity; document in reference |
| 2026-07-19 | Skip `pr-context` until v0.3+ | Requires `gh`; local-first v1 |
| 2026-07-19 | Default threshold 8/10 | Maps to Claude 80/100 |
| 2026-07-26 | CLI collapsed to `--lite` dual-mode; per-issue scorer default off; gate default Haiku | Lighten the CLI surface + align with Claude code-review |
| 2026-07-26 | Foreground directive mode via `sendUserMessage` (relies on pi-subagents); `--gate-model` restored; spawn path kept as fallback | Review visible in chat; gate model user-configurable |
