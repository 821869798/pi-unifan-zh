# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.8.3] - 2026-08-27

### Changed — report card UX (user decisions)
- **The `[pi-review]` echo is sent immediately** when `/review` runs, before
  the (potentially minutes-long) diff/clone preparation — no more long
  silent gap after submitting the command.
- **The report card always renders the FULL report.** The collapsed/expanded
  split (one preview line unless the host's global expansion toggle was on)
  made the card look like the report "didn't show up". The card now renders
  a `pi-review result:` summary line at the TOP with the full report body
  below it, regardless of the expansion state.
- **Summary line format:** `pi-review result: Approve · 0 blocker · 0 major
  · 0 minor · 0 nit` (title-case verdict; counts kept — user approved this
  line, just wanted the new prefix).
- The `pi_review_report` tool result line uses the same
  `pi-review result: ...` format (was `pi-review verdict: ... —`), and now
  points at the rendered card instead of duplicating it.

[0.8.3]: https://github.com/GeorgeDong32/pi-review/compare/v0.8.2...v0.8.3

## [0.8.2] - 2026-08-27

### Fixed
- **The gate-fallback branch now keeps the configured thinking level** via
  the child `thinking` parameter (consumed as an override upstream). When a
  proxy provider's model verification rejects the configured model and the
  gate retries with an inherited model, `gate.thinking` (e.g. `"high"`) is
  no longer silently dropped.
- Ops note: the model-verification strictness itself is addressed by a
  local patch to the installed pi-subagents (`~/.pi/agent/local-patches/`):
  containment of the observed id within the registered id passes as a
  warning-level match. That patch is lost on pi-subagents upgrades — re-apply
  from the archived patch file; the in-script fallback here remains the
  safety net either way.

[0.8.2]: https://github.com/GeorgeDong32/pi-review/compare/v0.8.1...v0.8.2

## [0.8.1] - 2026-08-27

### Fixed
- **Gate no longer dies on proxy providers' model verification.** First
  v0.8.0 field run: reviewers all completed, then the gate was rejected with
  `model_verification_failed: child reported a different model than the
  launch candidate. Expected 'CPA/Minimax/MiniMax-M2.7:high' but observed
  'MiniMax-M2.7'` — proxy providers report the bare upstream model id,
  which never matches the registered `provider/id` form. The gate launch is
  now wrapped in try/catch with a one-shot retry under the `gate-fallback`
  key that inherits the parent session model (the same path the reviewers
  use, which is why they never hit this). A second failure rejects as
  before; the configured model is still preferred when it works.
  (Different key because the runtime rejects same-key launches with
  different params.)

[0.8.1]: https://github.com/GeorgeDong32/pi-review/compare/v0.8.0...v0.8.1

## [0.8.0] - 2026-08-27

### Changed — Markdown-first output contract (user decision)
**Structured output is gone from the fan-out.** The `outputSchema` /
`structured_output`-tool finish contract kept failing in the field (v0.7.5:
"Missing structured_output call" after tool-budget wrap-ups; models chose
plain-text finishes). v0.8 removes the contract instead of patching it:

- **Reviewers (all 6 lanes) return Markdown reports** — Summary / Findings /
  Coverage sections, findings as `- [SEVERITY|category|confidence]
  \`file:line\` — evidence` bullets, `SKIPPED: <reason>` for non-applicable
  lanes. Nothing to un-escape, nothing to fail.
- **The gate (and the lite-reviewer) end their Markdown with exactly one
  fenced ```json verdict block** ({ status, verdict, issues[],
  dispositions[], reason }). That block is the only machine-read point;
  `pi_review_report` extracts it (fenced-first, brace-lift fallback, last
  well-shaped block wins) and re-applies the deterministic verdict rules on
  its issues.
- **The gate's inputs are the reviewers' Markdown reports** (inlined into
  its task, FAILED reviewers annotated) — the gate reads them the way an
  LLM reads best, re-scores, verifies blocker/majors against the diff +
  workspace, and emits the verdict block.
- The workflowScript shrinks again (~17 KB → ~9 KB full mode, 1.3 KB lite):
  no schema constants, no per-child `outputSchema`. Verified against the
  real installed pi-subagents 0.55.0 validator (PASS), the read-only task
  classifier (all 6 tasks read-only with Markdown payloads), and an
  end-to-end stub run including gate-Markdown → verdict-block extraction.
- Report rendering: reviewer Markdown is rendered verbatim under the status
  header; gate synthesis + surviving issues + dispositions follow. All
  reviewers skipped can no longer produce a clean APPROVE (downgraded to
  comment); a gate that ran but produced no parseable verdict block reports
  `no-gate`.

[0.8.0]: https://github.com/GeorgeDong32/pi-review/compare/v0.7.5...v0.8.0

## [0.7.5] - 2026-08-27

Hotfix for the first v0.7.4 field run: the workflowScript finally executed —
reviewers really ran (bugbot: 3m56s, 20 tool uses) — but steps ended with
`Error: Missing structured_output call; this step has outputSchema and must
finish by calling structured_output`, and bugbot's output file contained
only "I have enough context to finalize the review. Let me compile
findings." — the JSON never made it out.

### Fixed
- **Mandatory finish rule in every bundled agent prompt.** The old wording
  ("Return this JSON as your final reply. If the `structured_output` tool
  is available, call it once instead") let models choose a plain-text
  finish — fatal once the soft tool budget nudged a wrap-up. All 8 agents
  now carry a FINISH RULE block: the final action MUST be a single
  `structured_output` call (the only accepted finish; a plain-text reply
  FAILS the step), keep one tool call in reserve, and when the budget
  nudges, stop exploring and call it immediately.
- **Salvage path for prose finishes:** when a step fails with "Missing
  structured_output call" but its output text contains the JSON object
  (often wrapped in prose or a fence), `pi_review_report` now lifts the
  outermost `{…}` block and reports the reviewer as `limited` with its
  findings intact, instead of `failed` with everything dropped. Truly
  empty outputs still report `failed`, and a run whose reviewers are all
  salvaged can no longer be misreported as `error` (all-limited →
  `partial`).

[0.7.5]: https://github.com/GeorgeDong32/pi-review/compare/v0.7.4...v0.7.5

## [0.7.4] - 2026-08-27

Hotfix for the 2026-08-26 16:14 session: with v0.7.3's short-line script the
main agent's copy finally survived intact — and the workflow was then
rejected by pi-subagents' **AST validation**: "workflowScript does not
support nested async functions". The gate had been launched as
`gate: await (async () => { ... })()` since v0.7.0: an async IIFE, which the
upstream walker (scripted-workflow.ts) rejects outright. Every earlier
failure that got past the syntax stage had died at this same check — it was
simply invisible while copies were corrupting the script first.

### Fixed
- **The gate launch is now plain top-level statements** — `const
  reviewerInputs = reviewers.map(...)` (sync arrows are allowed), `const
  gateRun = await runs.run('gate', {...})`, `const gate = {...}`, then
  `return { reviewers, gate, reviewersShaped }`. No async IIFE anywhere.
- **Verified against the real installed pi-subagents 0.55.0
  `validateWorkflowScript`** (exported from the package): full and lite
  scripts both pass, and the script still executes end-to-end with stub
  runs.
- Contract test pins the constraint: the generated script must contain no
  `async` keyword at all (the runtime wraps the body itself), and the gate
  launch must be a top-level `const gateRun = await runs.run('gate', {`.

[0.7.4]: https://github.com/GeorgeDong32/pi-review/compare/v0.7.3...v0.7.4

## [0.7.3] - 2026-08-26

Hotfix for the PR 19291 incident (first run of v0.7.2): the main agent
followed the new workflow.js copy procedure exactly — read the file, copied
it verbatim, retried once per the hard rules, then stopped and notified as
instructed — and the review STILL died twice with "workflowScript must be
valid JavaScript". Byte-diffing the sent script against workflow.js showed
the copy had slipped a single character inside a 1400-char single-line
schema (`"maxLength":80,"description"` → `"maxLength":80",`).

### Fixed
- **The generated workflowScript no longer contains any long single lines —
  the actual root cause of every copy failure so far.** LLMs cannot
  byte-reliably copy a 21 KB blob, and the fragile spots were the huge
  lines, so the script now:
  - declares `REVIEWER_SCHEMA` / `GATE_SCHEMA` **once** as shared consts
    (was: the full schema inlined per child — 6 copies, ~10 KB of the
    script, in 1400-char lines); children reference `outputSchema:
    REVIEWER_SCHEMA`;
  - emits reviewer and gate **task text as short quoted arrays joined at
    runtime** (`task: ["…", "…"].join(" ")`) instead of one 900-char
    JSON.stringify line;
  - serializes schemas multi-line.
  Net effect: script 21.4 KB → 17.3 KB, **longest line 1469 → 342 chars**.
  Verified end-to-end: directive == workflow.js, parses, executes, and all
  six task texts still classify read-only under the real installed
  pi-subagents classifier.
- **`/review` command echo no longer collapsed into "pi-review · COMMENT".**
  The echo message shares the report's `pi-review` custom type, so the
  report renderer folded the user's own command away (the header extractor
  falls back to "comment" when no verdict is present). Echoes starting with
  `/review` now render verbatim as `[pi-review] /review …`.

[0.7.3]: https://github.com/GeorgeDong32/pi-review/compare/v0.7.2...v0.7.3

## [0.7.2] - 2026-08-25

Hotfix for the PR 19395 incident (2026-08-25, first run of v0.7.1): the
review stalled for 40+ minutes with "Workflow failed: workflowScript must
be valid JavaScript" three times in a row, then the main agent drifted into
hand-debugging the generated script.

### Fixed
- **The generated workflowScript is now presented to the main agent as an
  unescaped template literal (backticks), not a double-escaped JSON string.**
  The script body contains no backticks and no `${` (enforced by a plugin
  guard + contract test), so a straight copy is a valid script — there is
  nothing left for the main agent to unescape, which is exactly what failed:
  `subagent({ workflowScript: "...\\\"...\\n..." })` required the model to
  reverse the escaping while copying a 19 KB body, and any slip produced a
  syntax error (`summary"`typos,"`\"` lost, etc.).
- **The raw script is persisted to `.pi/pi-review/runs/<runId>/workflow.js`
  as an additional retry source.** If the copy is rejected with a parse
  error, the hard rule now says: `Read` `workflow.js` and repeat the call
  with exactly that content — once; on a second failure stop and notify the
  user. Hand-editing, re-quoting, or "fixing" the script is explicitly
  forbidden (the old rule allowed one fix and the model silently looped far
  beyond that).
- Plugin-side guard: if a future script template ever introduces a backtick
  or `${`, `buildReviewDirective` refuses to build the directive with a
  clear "plugin bug" error instead of feeding a corrupted copy to the model.

[0.7.2]: https://github.com/GeorgeDong32/pi-review/compare/v0.7.1...v0.7.2

## [0.7.1] - 2026-08-25

Post-mortem of the 2026-08 field reports (false positives, wrong diffs, gate
rejections after pi-subagents upgrades). Root causes verified against
CherryPR artifacts (17 PRs), 36 pi sessions, and the installed
pi-subagents 0.55.0 source.

### Fixed — upstream compatibility (pi-subagents 0.42→0.55)
- **Gate no longer rejected at launch:** pi-subagents ≥0.55 classifies task
  text for mutation intent and refuses read-only agents given
  "implementation" tasks. The gate task contained the bare verb "modify"
  ("lines the author did not modify") and got rejected with `Agent
  'pi-review.gate' was given an implementation task…` (observed 2026-08-24,
  which silently disabled gating). Every reviewer + gate task now carries a
  blanket read-only declaration ("READ-ONLY task — review only. Do not write
  any files. … Return findings only."), and `agents/gate.md` declares
  `acceptanceRole: read-only`. Verified against the real installed
  classifier: all tasks → `read-only`, `taskMayMutate=false`.
- **Acceptance-contract compliance:** the runtime appends an Acceptance
  Contract expecting a closing ```` ```acceptance-report ```` fence; our
  agents ended with "return JSON and stop", so every run's acceptance meta
  read `rejected`. All bundled agents now instruct compliance.
- **Contract tests pin the upstream heuristics** (read-only classification
  mirror, `chatProgress` enum, acceptance mention) so the next pi-subagents
  release fails our tests first, not every `/review` in the field.

### Changed — single diff authority + lifecycle (user decisions 2026-08-25)
- **`gh pr diff` is the single PR diff authority.** It is byte-for-byte what
  the GitHub web UI renders (same merge-base semantics), so a locally
  computed `git diff origin/main...FETCH_HEAD` substitute — no matter how
  carefully verified — can still diverge from what the user sees on the
  web. The git fallback path was removed entirely: `gh pr diff` failure now
  aborts the run with a clear "fix gh and re-run" error instead of
  computing its own diff. (`git-pr-fallback` stays in the manifest mode
  union only so pre-0.7.1 manifests keep parsing.)
- **Gate budgets tuned up again (user feedback):** 12→16 turns, 10→14 soft
  tools; wall clock 15→17 min. The verification duty (read the hunk + the
  touched file per blocker/major) needs the headroom.
- **End-of-run workspace reclamation:** a successful `pi_review_report`
  immediately removes the run's plugin-owned tmpdir clone (the report is
  already rendered + persisted). Concurrency-safe by construction — each
  run allocates a unique `pi-review-ws-<ts>-<rand>` root and the manifest
  records `workspaceCloned`, so reclamation never touches another run's
  clone or the user's cwd. Runs that die before reaching the report tool
  are still caught by the 24h TTL pruner on the next `prepareRun`.

### Fixed — diff correctness / stability
- **No more stale-ref fallback:** the git fallback previously fetched
  `pull/N/head` into a named branch and — when that fetch failed — silently
  reused whatever branch was already there (2026-08-12: an 8583-line diff
  for a 3-file PR, two phantom blockers, `request_changes` on a clean PR).
  As of the 2026-08-25 decision the fallback is gone altogether: the run
  aborts instead of ever substituting a locally computed diff.
- **Workspace/diff SHA reconciliation:** the target workspace checks out the
  PR head via `FETCH_HEAD` (detached) and its landed HEAD is compared with
  the diff's head SHA; a force-push race retries the clone once, then stops.
  `manifest.json` records `workspaceHeadSha` and the report shows whether it
  matches the diff head.
- **PR clone uses `gh repo clone` first** (private repos ride the gh
  credential) with plain-https fallback; a failed PR clone is now a hard
  error — the old silent fallback to the user's (possibly 247-commits
  stale) cwd produced the "diff@new, files@old" evidence split that drove
  false positives.
- **Cleanup:** scratch workspace clones older than 24h are pruned from the
  tmpdir on every run; legacy v0.5/0.6 flat artifacts
  (`.pi/pi-review/{change.diff,changed-files.txt,change-kind.txt,diff-meta.txt}`)
  are removed once per run (they were repeatedly misread as current-run
  inputs). Cleanup helpers no longer use ESM-`require()` (silently dead
  under some loaders).
- `git ls-remote --heads origin pull/N/head` (which can never match
  `refs/pull/*`) removed along with the code path it served.

### Fixed — gate accuracy
- **Gate can finally verify:** it receives the diff path + target workspace
  cwd, its budgets rose from 6 turns / 5 soft tools to 16 turns / 14 soft
  tools (user-tuned), and the wall clock from 10 to 17 minutes.
- **No silent drops of unverifiable majors:** the gate must keep
  blocker/major candidates it cannot verify at the reviewer's original
  confidence with an `unverified:` reason (field: two real majors killed
  2026-08-20; a confidence-7 real issue killed 2026-08-21). The report tool
  enforces this code-side: `unverified:` blocker/major dispositions are
  floored at the threshold (they survive into issues + verdict, evidence
  flagged `(unverified)`).
- **No confidence amplification without evidence:** never score above 8
  without the gate's own tool-verified evidence (field: an unverifiable
  "hand-edited generated file" claim became a confidence-10 blocker).
- **Missing confidence no longer means dropped:** issues arriving without a
  usable confidence default to a neutral 5 at ingestion (previously
  `undefined >= threshold` filtered out every such issue).
- Reviewer default turn budget 20→26 (field runs kept wrapping up partial
  at the soft limit).

### Fixed — adversarial round 2 (wiring, coverage semantics, contamination guards)
- **`gate.enabled` and `budgets.turnBudget` actually take effect:** both
  config keys were documented but never consumed by the execution path.
  `gate.enabled: false` now skips the gate while keeping the full reviewer
  roster; config turn budgets flow into the workflowScript (and the stale
  hard-coded default that would have regressed 26→20 was removed).
- **Mixed dirty trees review untracked files too:** a working tree with both
  modified and new files previously diffed only the tracked changes — new
  files (the ones most needing review) silently missed. Both parts are now
  combined into the run diff.
- **Stale-artifact contamination guard:** the directive's hard rules forbid
  reading `.pi-subagents/` (the 2026-08-24 incident had a failed workflow
  followed by old-artifact findings presented as the current PR's), and
  `pi_review_report` drops + surfaces findings whose reviewer key is not in
  the run's roster (manifest.reviewerIds).
- **All-limited coverage never yields a clean APPROVE:** when every reviewer
  returned `status: limited`, the report verdict is now `partial` instead of
  `approve` (the mirror of the no-gate incident: degraded coverage must not
  read as a pass).
- **Local stale-base warning:** a failed `git fetch origin <base>` with an
  existing remote-tracking ref now records a visible diff note instead of
  silently diffing against a stale base.
- **Diff-vs-workspace arbitration made explicit:** reviewer tasks state the
  diff is the authoritative change record; workspace files are context only.
- Trivial-change guard cleans up its orphan run dir; dry-run is fully
  side-effect free; README/config-comment drift fixed.

### Migration
- None. Config schema unchanged; behavior differences are all in-plugin.

[0.7.1]: https://github.com/GeorgeDong32/pi-review/compare/v0.7.0...v0.7.1

## [0.7.0] - 2026-08-16

### Added
- **Deterministic target workspace prep:** `/review` now clones/checks out the target repo (PR) or uses the user's cwd (local) and writes `.pi/pi-review/runs/<runId>/manifest.json` + `change.diff` before handing the directive to the main agent. Cross-repo PRs (e.g. reviewing `CherryHQ/cherry-studio` from the plugin's cwd) now point `history-context` / `code-comments` at the **target** workspace instead of the plugin repo.
- **`pi_review_report` tool:** renders the final report deterministically (dedupe → threshold → code-side verdict) from the workflow return value, persists a session entry, and is the only authoritative report source.
- **`/review-show`:** re-renders the most recent `pi-review` session entry.
- **Collapsible TUI renderer**: `registerMessageRenderer("pi-review")` collapses long reports into a verdict + count preview line.
- **Dispositions:** the gate now records per-candidate keep/drop/merge audits (`src/types.ts GateDisposition` + `agents/gate.md`).

### Changed
- **`chatProgress` fixed:** the directive emits `chatProgress: "auto"` (was an invalid `"milestones"` value rejected by pi-subagents).
- **Structured output hard requirement:** every reviewer and gate child carries `outputSchema`; the workflowScript consumes `result.structuredOutput`, never free-text `result.output`. Reviewers return `status` (`ok | limited | skipped`) and `coverage`.
- **Model inheritance preserved:** `model: "inherit"` reviewers no longer get a concrete per-child `model` clause injected (fixes silent inheritance loss).
- **Strict verdict default:** `enforceGateOutput` uses `strict` policy — any surviving blocker/major → `request_changes` (was `≥3 majors`). Legacy policy available via `verdictPolicy: "legacy"`.
- **Gate prompt:** re-scores every candidate, emits `dispositions`, and no longer consumes Markdown fenced JSON.
- **Diff acquisition moved into the plugin:** `src/review-run.ts` fetches `gh pr view` / `gh pr diff` / git fallback, records base/head SHAs, diff SHA-256, changed files (derived from the diff only), rule paths, docs-only flag.

### Removed
- `/review` no longer auto-writes `.pi/projects/<id>/permissions.local.json`; diff/clone/fetch happens via the extension's own subprocesses.
- **Legacy spawn pipeline deleted:** `src/spawn.ts`, `src/gate.ts`, `src/review.ts`, `src/issue-score.ts`, `src/args.ts`, `src/obtain-diff.ts`, `src/prep.ts`, `src/git-input.ts`, `src/eligibility.ts`, `src/paths.ts`, `src/structured-output-capture.ts`, `src/parallel.ts`, `src/schema.ts`, `src/run.ts`, `scripts/smoke-acceptance.ts`, `prompts/gate.md`, and their tests. The foreground workflowScript path is the only supported execution path.
- **Config knobs that could not be honored removed:** `concurrency`, `inheritance`, `gate.scorePerIssue`, `reviewers.<id>.tools`, `reviewers.<id>.timeoutMs`. Legacy keys still parse (with one migration warning) but no longer affect behavior.

### Added
- `routing.mode` (`adaptive` | `all`): drops clearly-inapplicable reviewer lanes up front (no rule files / docs-only / no git history). Skipped lanes appear in the report.
- `gate.verdictPolicy` (`strict` | `legacy`): code-side verdict rule selection.

### Migration
- Config `schemaVersion` stays 1; old configs continue to load.

[0.7.0]: https://github.com/GeorgeDong32/pi-review/compare/v0.6.2...v0.7.0

## [0.6.1] - 2026-08-08

### Fixed
- **Agent permission blocks removed:** pi-subagents ≥0.42 rejects the legacy nested `permission:` frontmatter (`bash:` sub-maps, `"*": ask` wildcard) with `permissions must be an object mapping tool names to allow, ask, or deny`. The new model gates bash via pi-guard and only accepts flat `tool → allow|ask|deny` (no `*` wildcard, no `bash` key). All 8 bundled agents now rely on their `tools:` allowlist (the primary constraint) and omit `permission:` entirely.

[0.6.1]: https://github.com/GeorgeDong32/pi-review/compare/v0.6.0...v0.6.1

## [0.6.0] - 2026-08-07

### Breaking
- **workflowScript migration:** fan-out now runs through one `subagent({ workflowScript, async:false })` instead of the removed top-level `subagent({ tasks:[...] })` (pi-subagents ≥0.41 dropped legacy `tasks`/`chain`/`concurrency`). Step 2 and the gate merge into a single tool call: the script fans out reviewers via `runs.all([...])`, then feeds their inlined JSON findings to `runs.run("gate", ...)`.
- **Peer deps:** `@mariozechner/*` → `@earendil-works/*`; added `pi-subagents >=0.41.0` (provides the `workflowScript` API). Source imports (`index.ts`, `src/run.ts`, `src/structured-output-capture.ts`) and devDependencies migrated to `@earendil-works/pi-coding-agent` as well; peer floor raised to `>=0.74.0` (lowest version published under the new scope).
- **Removed directive params:** `reads: false`, `acceptance: false`, top-level `outputMode: "file-only"`, and `concurrency` — `reads` is not a valid top-level `subagent` field and would fail schema validation. Reviewers now return JSON as their final reply; the script captures `result.output`.

### Changed
- **Inline gate:** the gate task receives reviewer JSON inlined as text (no file-only indirection). Per-child `toolBudget`/`turnBudget` are injected onto each `runs.all` / `runs.run` item.
- **Reviewer prompts:** all `agents/*.md` now say "return JSON as your final reply" (the `structured_output` fallback is kept for the legacy spawn path).
- **Tests:** `tests/directive.test.ts` rewritten for the workflowScript shape (legacy-input `doesNotMatch` guards added).

[0.6.0]: https://github.com/GeorgeDong32/pi-review/compare/v0.5.3...v0.6.0

## [0.5.3] - 2026-07-31

### Fixed
- **Stale base diffs:** Step 1 now `git fetch`es the remote default branch and compares against `origin/<base>` (not a stale local `main`/`master`). PR path still prefers `gh pr diff`, with a fetch `pull/<n>/head` + three-dot fallback. Writes `.pi/pi-review/diff-meta.txt` (mode / base / SHAs / merge-base) for audit.
- Allowlist adds `git fetch` / `git merge-base` / `git ls-files` for the obtain-diff path.

## [0.5.2] - 2026-07-30

### Changed
- **Single-wave hard rules:** at most 2 `subagent` calls (1 fan-out + 1 gate); no per-reviewer serial calls; no retries on timeout/partial.
- **turnBudget** default **20** (config `budgets.turnBudget`, up to 24/48); toolBudget soft/hard raised slightly.
- **Reviewer thinking inherits** the parent session (no forced medium/low on lean agents). Gate uses `config.gate.model` + `config.gate.thinking` as `model:thinking`.
- **Diff companion files:** write `.pi/pi-review/changed-files.txt` + `change-kind.txt` (`docs`|`code`); docs-only → bugbot/security empty early-exit.
- **Shallow prompts:** diff-first; history one multi-path `git log`; bugbot/security may use allowlisted `git show|log|blame` when needed.

### Added
- **CC-aligned permission allowlist** (`src/review-permissions.ts`): Claude `/code-review` 7× `Bash(gh …:*)` plus history/obtain git + `Read`/`Grep`. `/review` merges them into `.pi/projects/<id>/permissions.local.json` (permission-modes) so headless children are not blocked.

[0.5.3]: https://github.com/GeorgeDong32/pi-review/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/GeorgeDong32/pi-review/compare/v0.5.1...v0.5.2

## [0.5.1] - 2026-07-28

### Changed
- **Token-lean subagent fan-out:** the directive now pins every reviewer to a lean `pi-review.*` package agent (not the builtin fat `reviewer`), with explicit `turnBudget` / `toolBudget`, `reads: false`, `outputMode: "file-only"`, and `acceptance: false`.
- **Shared diff under cwd:** write to `.pi/pi-review/change.diff` (not `/tmp/...`) so children can read it without outside-cwd blocks. Main agent must **write-only** — no read/summarize of the full diff; report from file-only outputs only.
- **Lean agent prompts:** short CC-style briefs; `inheritProjectContext: false`; no obtain-change playbook; history capped at ≤5 files / `git log -n 5`.
- Package agents registered via `pi.subagents.agents: ["./agents"]` (runtime names like `pi-review.bugbot`, `pi-review.gate`).
- Default `inheritance.inheritProjectContext` is now `false`; reviewer tool lists narrowed.

### Fixed
- Directive path previously ignored pi-review config `tools` / `thinking` / inherit flags because the main agent fell through to builtin `reviewer` (`thinking: high`, edit/write/intercom, project context on).

[0.5.1]: https://github.com/GeorgeDong32/pi-review/compare/v0.5.0...v0.5.1

## [0.5.0] - 2026-07-27

### Changed
- **Foreground review**: `/review` now delegates to the main agent via a hidden directive (`sendMessage` with `display:false` + `triggerTurn:true`); the main agent fans out reviewers + gate with the pi-subagents `subagent` tool. The whole review streams in chat — no more silent background spawn. **Requires the pi-subagents extension.**
- **Main agent owns the diff**: the directive has the main agent obtain the diff once into `/tmp/pi-review-change.diff`; reviewers read that file instead of each fetching separately.
- **Hidden directive, visible echo**: only a short `/review <prompt>` line shows in chat; the full directive is hidden.
- **Top-level config**: moved to `~/.pi/agent/pi-review.json` (mirrors pi-permission-modes); added `setConfigPath` for tests.
- **Gate model** defaults to a cheap tier (`anthropic/claude-haiku-4-5`); override via config or the restored `--gate-model` flag.
- **per-issue scorer** default `off` (was `blocker-major`).
- **CLI slimmed**: `/review` surface reduced to `--lite` + freeform prompt; removed flags are accepted-but-ignored (their capabilities moved to config).

### Added
- **`--lite` mode**: single-agent fast review (`agents/lite-review.md`), no fan-out/gate.
- **Workflow checklist**: the directive has the main agent post a markdown checklist of the steps first, then work through it (pi has no native todo tool).
- `getArgumentCompletions` for `--lite` / `--gate-model`.

### Removed
- Code-enforced verdict — now instructed to the main agent (LLM follows the rule, but no longer a hard guarantee). The background spawn path is kept as a fallback.

[0.5.0]: https://github.com/GeorgeDong32/pi-review/compare/v0.4.1...v0.5.0

## [0.4.1] - 2026-07-26

### Fixed
- **UI feedback during `/review`:** immediate notify + footer status; per-reviewer progress; errors surface via notify + message.
- Stop calling `gh pr diff` during target resolve (was blocking the TUI with no output while the backend worked). Oversized hint comes from `gh pr view` metadata instead.

[0.4.1]: https://github.com/GeorgeDong32/pi-review/compare/v0.4.0...v0.4.1

## [0.4.0] - 2026-07-26

### Changed
- **Agent-driven change acquisition (CC-aligned):** the plugin no longer pre-fetches or embeds a full diff. Reviewers obtain the change via `gh` / `git` / `read` using an obtain-change playbook in the task prompt.
- Oversized PRs (`gh pr diff` HTTP 406 / too_large) no longer abort the pipeline; agents fall back to git / path-scoped reads.
- Gate and per-issue scorers receive metadata + reviewer JSON only (no full `<diff>` embed).
- All content reviewers include `bash` so they can run `gh`/`git`.

### Added
- `ReviewTarget` + `resolveReviewTarget` (`pr` | `diff-file` | `local-git`).
- Optional `gh pr view` metadata prep and `probeNote` for dry-run.

[0.4.0]: https://github.com/GeorgeDong32/pi-review/compare/v0.3.1...v0.4.0

## [0.3.1] - 2026-07-26

### Changed
- **CC-aligned `/review` args:** positional text is **user context** (PR URL/number, instructions), not a filesystem path. Fixes `ENOENT` when passing GitHub PR links.
- PR URLs/numbers resolve via `gh pr diff`; explicit diff files use `--diff @file.diff`.

### Added
- `src/pr-ref.ts` — extract PR refs from freeform input (handles CJK punctuation like `，review`).

[0.3.1]: https://github.com/GeorgeDong32/pi-review/compare/v0.3.0...v0.3.1

## [0.3.0] - 2026-07-26

### Added
- **Code-side gate enforce** (`src/gate-enforce.ts`): deterministic dedupe + threshold filter + verdict rules after the gate LLM (Claude Phase 5 equivalent).
- **Full diff to gate**: gate task includes the complete review body inside `<diff>` (no 2KB slice).
- **Optional per-issue scorers** (`gate.scorePerIssue`, default `blocker-major`): Claude Phase 4–style parallel confidence scoring for high-severity findings (`prompts/issue-score.md`).
- CLI: `--score-per-issue off|blocker-major|all`; `--threshold` is clamped to 0–10.

### Fixed
- Spawn: drain stdout to avoid pipe deadlock; reject non-zero child exit even when `output.json` exists.
- Report: list final gate issues in markdown; mark unfiltered totals when gate is missing/failed.
- ESM: replace `require()` in `paths.ts` / `prep.ts` / `git-input.ts` so `tsx --test` works under pure ESM.

[0.3.0]: https://github.com/GeorgeDong32/pi-review/compare/v0.2.0...v0.3.0

## [0.2.0] - 2026-07-19

### Added
- `index.ts` — registers `/review`, `/review-config`, `/review-agents`.
- Claude-shaped pipeline: **eligibility → prep → reviewers → gate → report** (`src/eligibility.ts`, `src/prep.ts`, `src/run.ts`).
- `src/structured-output-capture.ts` — child extension for `structured_output` tool; loaded via `-e` on subagent spawns.
- `src/cli-args.ts` — flag parsing for `/review`.
- New reviewers: `bugbot` (replaces `bug-detector`), `security-review`, `code-comments`.
- `reference/` docs (Claude flow, Cursor skills, roadmap, v0.2 plan).
- Tests: eligibility, prep, cli-args (+104 total).

### Changed
- Default gate threshold **3 → 8** (maps to Claude 80/100).
- Bundled `agents/*.md` and `prompts/gate.md` wired as subagent system prompts.
- Gate prompt embeds Claude confidence rubric (1–10 re-score).
- `conventions` reviewer default **disabled**.
- `@sinclair/typebox` moved to `dependencies` (capture extension runtime).

### Removed
- `agents/bug-detector.md` (renamed to `bugbot.md`).

## [0.1.0] - 2026-07-02

### Added
- `/review [path]` slash command — fans the diff out to four parallel reviewer subagents (`claude-md-compliance`, `bug-detector`, `conventions`, `history-context`) and aggregates their structured output through a single cheap-model gate.
- `/review-config` — opens `~/.pi/agent/extensions/pi-review/config.json` in `$EDITOR` and re-validates on close.
- `/review-agents` — lists the bundled reviewers with their resolved model, thinking, and tool lists.
- Smart default diff source: dirty working tree → `git diff HEAD`; clean tree → `git diff <default-branch>...HEAD`. Probes `origin/HEAD` → `main` → `master` → current branch.
- Per-reviewer model / thinking / tool overrides via `~/.pi/agent/extensions/pi-review/config.json`. `"inherit"` resolves to the parent session's model at run time.
- Flags: `--threshold N`, `--reviewer id...` (repeatable), `--no-gate`, `--gate-model id`, `--no-spawn` (dry run).
- TUI output: full report rendered as an `assistant` text block. Machine-readable copy written via `pi.appendEntry("pi-review", ...)` for future collapse-aware consumers.
- Structured output via TypeBox schemas. Subagents receive the JSON Schema via `PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA` and write the validated payload to `PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE`. Parent re-validates with `validateValue`.

### Changed
- Each reviewer / gate runs as a fresh, isolated `pi` subprocess (`--no-session --no-extensions --no-skills`) — mirrors the pattern from `pi-subagents`.
- Hard cap of 4 concurrent reviewers, regardless of `concurrency` in config.
- The gate is spawned with no tools — pure reasoning on the aggregated prompt.

### Out of scope (deferred)
- Retry loop for failed reviewers.
- Worktree-per-reviewer isolation.
- GitHub / `gh` integration (PR comment posting).
- Inline fix suggestions / auto-apply.
- Multi-PR batch mode.
- Web UI for configuration.
