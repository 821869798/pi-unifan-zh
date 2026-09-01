# Claude Code Review — reference

> **Source of truth:** `anthropics/claude-plugins-official` → `plugins/code-review/commands/code-review.md`  
> **Secondary (may be stale):** `plugins/code-review/README.md` — describes 4 agents and “2× CLAUDE.md compliance”; the command file is authoritative and lists **5 distinct content agents**.

Last verified: 2026-07-19.

## Product intent

Automated PR review: multiple independent agents audit the same change from different angles, then **confidence scoring** filters false positives so only high-signal issues are posted.

- **Trigger:** `/code-review` (GitHub PR context, uses `gh`)
- **Output:** PR comment with issues ≥ threshold (default **80/100**), or no comment if none qualify
- **Not in scope:** auto-fix, harness gating merges, worktree isolation

## Pipeline (ordered phases)

Claude is **not** “spawn N reviewers and done”. It is a **sequential pipeline** with one parallel batch in the middle.

```
┌─────────────────────────────────────────────────────────────────┐
│ Phase 1 — Eligibility (Haiku)                                   │
│ Skip if: closed, draft, trivial/automated, already reviewed     │
│ → STOP if ineligible                                            │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 2 — Prep (Haiku, sequential)                              │
│ 2a. List paths to relevant CLAUDE.md files (not full contents)  │
│ 2b. Summarize PR / change                                       │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 3 — Content review (5× Sonnet, PARALLEL)                  │
│ Each returns issues + reason flagged (compliance, bug, history…)  │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 4 — Confidence scoring (Haiku, PARALLEL per issue)        │
│ One scorer agent per issue from Phase 3                         │
│ Rubric: 0 / 25 / 50 / 75 / 100 (verbatim in command)            │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 5 — Filter                                                │
│ Drop issues with score < 80 (configurable in command)           │
│ → STOP if no issues remain (no comment posted)                  │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 6 — Re-eligibility (Haiku)                                │
│ Repeat Phase 1 checks before posting                            │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 7 — Output (`gh pr comment`)                              │
│ Brief markdown; link file:line with full SHA                    │
└─────────────────────────────────────────────────────────────────┘
```

## Phase 3 — five content agents (command file)

| # | Task | Focus |
|---|------|--------|
| 1 | CLAUDE.md compliance | Rules in CLAUDE.md; not every writing-time instruction applies at review time |
| 2 | Bug detector | Shallow scan of **diff only**; large bugs; ignore nitpicks and likely FPs |
| 3 | History | `git blame` + history on modified code; bugs in light of historical context |
| 4 | Previous PRs | PRs that touched same files; comments that may apply to current PR |
| 5 | Code comments | Inline comments in modified files; change must comply with comment guidance |

Agents run **in parallel** after prep. They do **not** score their own issues for final output.

## Phase 4 — confidence rubric (0–100)

Given verbatim to each scorer (summarized):

| Score | Meaning |
|-------|---------|
| **0** | False positive; does not survive scrutiny; or pre-existing |
| **25** | Might be real; cannot verify; stylistic without explicit CLAUDE.md callout |
| **50** | Real but minor / nitpick / rare in practice |
| **75** | Verified likely real and important; or explicitly in CLAUDE.md |
| **100** | Certain; will happen in practice; direct evidence |

**CLAUDE.md issues:** scorer must verify the guideline **explicitly** mentions the issue.

**Default threshold:** 80 — issues below are dropped.

## Documented false positives (Phases 3–4)

Scorers are instructed to down-rank:

- Pre-existing issues not introduced in the PR
- Things that look like bugs but are not
- Pedantic nitpicks a senior engineer would skip
- Linter / typechecker / formatter / import / test failures (CI handles)
- General quality (tests, docs, generic security) **unless** CLAUDE.md requires it
- Issues silenced in code (e.g. lint-ignore)
- Intentional functional changes related to the PR scope
- Real issues on lines the author did not modify

**Explicit non-goals:** do not build or typecheck; do not use web fetch for GitHub (use `gh`).

## README vs command discrepancies

| Topic | README | Command (`code-review.md`) |
|-------|--------|----------------------------|
| Content agent count | 4 (2× compliance + bug + history) | **5** distinct roles |
| Agent #2 | Second compliance | **Bug detector** |
| Agents #4–5 | Not listed | Previous PRs + code comments |
| Scoring | “Nx confidence scorers” | One Haiku per issue, parallel |

**For pi-review alignment, follow the command file.**

## Architecture notes (from README technical section)

- Compliance redundancy in README (“2×”) is **not** what the current command specifies.
- Scoring is **per issue**, not one aggregating judge.
- GitHub integration: `gh pr view`, `gh pr diff`, blame/history, post comment.

## Implications for pi-review

| Claude phase | pi-review adaptation (v0.4) |
|--------------|-------------------------|
| 1 Eligibility | PR ref / `--diff` / git repo; optional trivial probe for local-git only |
| 2 Prep | Rule-file paths + lightweight `gh pr view` / hint metadata (no full diff) |
| 3 Content (5) | Bundled reviewers **obtain the change themselves** (gh/git/read playbook) |
| 4 Scoring | Gate + optional per-issue scorers on reviewer evidence (no full diff embed) |
| 5 Filter | Code-side threshold (map 80/100 → 8/10) |
| 6 Re-eligibility | Target still present before render |
| 7 Output | TUI markdown + `appendEntry`; no `gh pr comment` yet |

**v0.4 design note:** Claude `/code-review` is an instruction document for the main agent. pi-review keeps parallel spawn + structured_output + gate enforce in the plugin, but must not hard-fail on `gh pr diff` — oversized PRs are handled inside reviewer tool loops.
