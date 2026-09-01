# Cursor Bugbot & Security Review — reference

> **Source:** Cursor built-in skills `review-bugbot`, `review-security` (subagent invocation patterns).

Last verified: 2026-07-19.

## Product intent (Cursor)

**Single-purpose review skills** — user manually invokes `/review-bugbot` or `/review-security`. Each launches **one** specialized subagent. There is **no** multi-phase pipeline, no gate, no per-issue confidence loop.

Cursor’s general `/review` skill routes to these specialists; they are **not** a full clone of Claude code-review.

## Invocation contract

Both skills use the same prompt shape:

```text
Full Repository Path: <absolute path>
Diff: <"branch changes" | "uncommitted changes">
Base Branch: <optional; only when comparing against a known non-default base>
Custom Instructions: <optional>
```

| `Diff` value | Meaning |
|--------------|---------|
| `branch changes` (default) | Merge-base vs default branch; includes committed + staged + unstaged |
| `uncommitted changes` | Working tree only |

Subagent computes diff internally — caller should **not** pre-compute diff.

**PR / branch special case:** checkout target branch before launch; stash only with user confirmation.

## Subagent types

| Skill | `subagent_type` | Purpose |
|-------|-----------------|---------|
| `/review-bugbot` | `bugbot` | Correctness / logic bugs in the change |
| `/review-security` | `security-review` | Security issues in the change |

## Output discipline

After subagent completes, parent summarizes:

- Empty diff → one-line “no diff”
- No issues → one-line status
- Issues → markdown table: **Severity | Location (file:line) | Finding**, sorted by severity

**Do not** auto-fix or re-run unless user asks.

## Retry policy

- Wrong invocation shape → fix and retry once
- Other failures → retry once with same prompt
- Still failing → stop, report error (no infinite retry)

## What to borrow for pi-review

| Borrow | Do not borrow |
|--------|----------------|
| Bug-focused diff scope (no whole-repo nitpicks) | Single-subagent-only UX (we use parallel reviewers) |
| Security category checklist mindset | Letting subagent compute diff (we resolve diff in parent) |
| Compact table-friendly findings | Separate `/review-bugbot` commands (use `/review --reviewer`) |
| “Only changed lines” discipline | Cursor’s Task/subagent harness |

## Mapping to pi-review agents

| Cursor | pi-review agent (planned) | Notes |
|--------|---------------------------|-------|
| `bugbot` | `bugbot` (rename from `bug-detector`) | Align prompt with Cursor output discipline |
| `security-review` | `security-review` (new) | `category: security` in schema already exists |

These are **Phase 3 content reviewers** in our pipeline, not replacements for eligibility, prep, or gate.
