# 🌟 pi-unifan-zh (Pi Chinese Extensions Collection & Monorepo)

A high-quality collection of Chinese-localized extensions and skills for **Pi Coding Agent**.

Supports both **All-in-One Bundle Installation** and **Individual Single-Package Installation**.

[中文说明文档 (Chinese Documentation)](./README_zh.md) | [开发与发版指南 (Developer & Agent Guide)](./AGENTS.md)

---

## 📁 Repository Structure

```text
pi-unifan-zh/
├── package.json              # Root bundle manifest (all-in-one install)
├── tsconfig.json             # TypeScript configuration
├── AGENTS.md                 # Developer and AI agent guidelines
├── README.md                 # English Documentation
├── README_zh.md              # Chinese Documentation
├── extensions/               # 📦 Extension Packages
│   ├── sessions/             # 📜 ① Dual-pane session manager with live preview (Chinese)
│   ├── review/               # 🔍 ② AI multi-agent code review suite (Daily/Lite/Perf/Full)
│   ├── commit/               # 📦 ③ Intelligent Conventional Commits assistant (Chinese)
│   └── workflow/             # 🔄 ④ Compound Engineering Workflow engine (State/Checkpoints/Filters)
└── skills/                   # 🎯 Compound Engineering Skills (00-next ~ 05-learn)
    ├── 00-next/              # 🚦 Router & orchestrator (inspects repo state, recommends next step)
    ├── 01-brainstorm/        # 💡 Discovery & flexible interactions (single/multi-select/custom text)
    ├── 02-plan/              # 📐 TDD architecture planning & Implementation Units
    ├── 03-work/              # 🛠️ Strict TDD coding execution & checkpoint resume
    ├── 04-review/            # 🧐 Code review, spec verification & regression testing
    └── 05-learn/             # 📝 Lightweight solution cards & knowledge compounding
```

---

## 🚀 Installation Guide

### Option A: All-in-One Bundle Install (Recommended ⭐)

#### 1. Via npm:
```bash
pi install npm:@unifan/pi-unifan-zh
```

#### 2. Via GitHub:
```bash
pi install git:github.com/821869798/pi-unifan-zh
```

#### 3. Local Installation:
```bash
pi install D:/program/my/pi-unifan-zh
```

---

### Option B: Install Individual Extensions

Each extension is published as a standalone npm package and can be installed individually:

> 💡 **Note**: Pi CLI's `git:` source only supports cloning the entire repository root. For **installing individual extensions**, use the recommended `npm:` method or local paths.

#### 1. Install `sessions` (Session Manager with TUI Preview):
```bash
# Via npm
pi install npm:@unifan/pi-sessions-zh
# Or via local path
pi install D:/program/my/pi-unifan-zh/extensions/sessions
```

#### 2. Install `review` (AI Parallel Code Review Suite):
```bash
# Via npm
pi install npm:@unifan/pi-review-zh
# Or via local path
pi install D:/program/my/pi-unifan-zh/extensions/review
```

#### 3. Install `commit` (Intelligent Git Commit Assistant):
```bash
# Via npm
pi install npm:@unifan/pi-commit-zh
# Or via local path
pi install D:/program/my/pi-unifan-zh/extensions/commit
```

#### 4. Install `workflow` (Compound Engineering Engine & Skills):
> Includes `/workflow` command, checkpoint persistence, token filters, and all 6 workflow skills (`00-next` ~ `05-learn`).
```bash
# Via npm
pi install npm:@unifan/pi-workflow-zh
# Or via local path
pi install D:/program/my/pi-unifan-zh/extensions/workflow

# Recommended peer question UI extension:
pi install npm:@juicesharp/rpiv-ask-user-question
```

---

## 📦 Features & Commands

### 1. 📜 `sessions` (Session Picker & Live Preview)
- **Command**: `/sessions`
- **Features**:
  - Full-screen dual-pane TUI view with live conversation preview.
  - Formatted badges for `◆ User`, `● Assistant`, `◌ Thinking`, and tool outputs.
  - Fully localized Chinese interface and relative timestamps.
- **Shortcuts**:
  - `Enter`: Switch to and restore selected session.
  - `t`: Expand / collapse tool output.
  - `h`: Toggle model thinking visibility.
  - `Tab`: Switch focus between session list and preview pane.
  - `PgUp` / `PgDn`: Scroll preview pane.
  - `Ctrl+T` / `Alt+W`: Toggle all workspaces / current project.
  - `Esc`: Exit picker.

---

### 2. 🔍 `review` (Interactive AI Code Review Suite)
- **Architecture Highlights**:
  - Re-architected following the battle-tested **Codex & pi-agent-extensions** design (by Armin Ronacher @mitsuhiko).
  - **Dual Execution Engine**:
    - ① **Single-Model Native Review (Default & Recommended)**: 0 subagent dependencies, 0 network dropouts, ultra-fast & 100% reliable.
    - ② **Multi-Subagent Concurrent Review**: Freely configure **2, 3, 4, 5, or 6** concurrent expert subagents (Bugbot, Security, Perf, Compliance, Comments, History).
  - **Session Model & Thinking Level Inheritance**: Single-model review and final synthesis run directly in the current session. Multi-expert review launches through one asynchronous workflow and explicitly passes the current session's `provider/model:thinking-level` to every expert, preventing subagent defaults from overriding the session settings.
- **Commands**:
  - **`/review`** 🔍: Launches interactive Chinese TUI menu with 6 review modes + settings:
    - ① `Review uncommitted changes` (staged + unstaged working tree, smart default)
    - ② `Review against base branch` (auto merge-base calculation against main/master/dev)
    - ③ `Review specific commit` (search and pick from recent commits)
    - ④ `Review GitHub Pull Request` (auto local checkout via gh CLI)
    - ⑤ `Review folder/files snapshot` (full snapshot audit, non-diff)
    - ⑥ `Custom review focus` (concurrency, GC, security, API contracts)
    - ⑦ `⚙️ Review Configuration` (configure Single Model vs Multi-Subagent 2~6 experts)
  - **`/review-config`** ⚙️: Standalone interactive settings command (persisted to `~/.pi/agent/pi-review.json`).
  - **`/review-lite`** ⭐: Directly audits current uncommitted changes without menu prompts.
  - **`/review-full`** 🚀: Full-scope deep review on all changes without redundant setup steps or checklists.
  - **`/review-sync`** 🔄: Dual-session review relay loop (auto-detects role: dev fixes code & explains why, reviewer validates actual diff without editing until approved).
  - **`/review-end`** 🏁: Finish review, summarize action items, and jump back to the main development session (alias: `/end-review`).
- **CLI Flags**:
  - `/review --subagents -c 2`: Temporarily launch review with 2 concurrent subagents.
  - `/review --single`: Force single-model native review.
- **Standards & Guidelines**:
  - **P0~P3 Strict Severity Tags**: Blocker, Urgent, Normal, Low.
  - **Zero Speculation & Grounded in Diff**: Every finding is backed by source evidence.
  - **Custom Guidelines**: Automatically respects repo-level `REVIEW_GUIDELINES.md`, `AGENTS.md`, or `CLAUDE.md`.

---

### 3. 📦 `commit` (Intelligent Conventional Commits Assistant)
- **Commands**:
  - **`/commit`**: Analyzes staged and working-tree changes (`git diff`), uses the current session's model and thinking level through the provider's unified parameter handling, and generates a Chinese Conventional Commit message from the actual staged changes before committing. Authentication, request, empty-response, or output-validation failures display the reason and stop the commit and push, preserving staged changes without substituting a generic fallback message.
  - **`/commit-push`** 🚀: Generates Chinese commit and automatically executes `git push` to remote.
- **Usage & Flags**:
  - `/commit`: Smart commit (commits staged changes if staged, or auto-stages all if unstaged).
  - `/commit -a` / `/commit --all`: Auto-stages all workspace changes (`git add -A`) and commits.
  - `/commit <hint>`: Guides commit message generation with user instructions.
- **Key Engineering Standards**:
  - **11 Standard Types**: `feat`, `fix`, `perf`, `refactor`, `ci`, `build`, `chore`, `docs`, `test`, `style`, `revert`.
  - **Strict ASCII Punctuation**: Parentheses `()` and colon `: ` strictly use ASCII half-width characters for CI / Commitlint compliance.
  - **No Emoji**: Clean, professional plain text commit style.
  - **Smart Auto-Rebase on Push**: In `/commit-push`, if remote contains unpulled commits, it automatically runs `git pull --rebase` and retries push, keeping a clean linear git history.
  - **Smart Conflict Guidance**: If rebase conflicts occur, lists conflict files and enforces resolving by diff and context (never blindly using ours/theirs).
  - **Unpushed Commits Sync**: Automatically pushes unpushed local commits even if the working tree is clean.

---

### 4. 🔄 `workflow` & Compound Engineering Workflow Suite
Turn your AI coding agent into a disciplined software engineer through an iterative stage-gated pipeline:

```text
00-next  ──>  01-brainstorm  ──>  02-plan  ──>  03-work  ──>  04-review  ──>  05-learn
 (Router)        (Discovery)      (TDD Plan)    (Execution)      (Review)      (Compounding)
```

- **Commands & Tools**:
  - **`/workflow`**: Inspect current project stage, artifact counts, active autonomous driving loop progress, and recommended next skill.
  - **`workflow_state` tool**: Automatically scans `docs/` and `.context/checkpoints/` state.
  - **`artifact_helper` tool**: Resolves standardized artifact paths for requirements, plans, and solutions.
  - **`session_checkpoint` tool**: Saves and restores execution breakpoints at the Implementation Unit level — resume right from where you left off.
- **6 Built-in Pipeline Skills**:
  - **`00-next` (Router & Orchestrator)**: Say `continue` or type `/skill:00-next`, and it automatically guides you to the right next step.
  - **`01-brainstorm` (Requirements Discovery)**: Clarifies scope and architecture decisions. **Pairs with `@juicesharp/rpiv-ask-user-question`** for flexible interactions: single-select (1-9 hotkeys) for mutually exclusive choices, multi-select checkboxes for feature lists, and custom text inputs.
  - **`02-plan` (Architecture Planning)**: Decomposes requirements into TDD Implementation Units following The Ladder minimalism principles.
  - **`03-work` (Autonomous Loop TDD Coding)** 🚀: **Built-in autonomous continuation engine similar to `goal`**. Directly invoking `/skill:03-work` starts a background cross-turn driver that sequentially executes Implementation Units with red-green-refactor, **never stopping until all planned units are 100% completed**! Supports checkpoint resumption and strict Stop-The-Line policy. Type `pause`, `stop`, or press `Esc` to pause anytime.
  - **`04-review` (Quality & Spec Review)**: Verifies git diff, checks Spec contract compliance, and ensures clean regression tests.
  - **`05-learn` (Knowledge Compounding)**: Lightweight, pragmatic pitfall compounding into `docs/solutions/` — zero noise, only non-trivial insights.
- **Context Optimizers (Token Savers)**:
  - **`bash` smart filter**: Automatically summarizes verbose command outputs (`npm install`, verbose logs), saving 80%+ context tokens.
  - **`read` smart filter**: Compresses oversized lockfiles (e.g. `package-lock.json`) and long logs into compact structural summaries.

### 🔄 How 03-work Autonomous Loop Works

Traditional AI coding tools stop after each turn, asking for user confirmation before doing the next step. `03-work` natively integrates the `WorkLoopDriver` engine:
1. **Lifecycle Event Hook**: Binds to Pi's `agent_settled` event to verify execution state immediately after each turn finishes.
2. **Bi-directional Checkpoint Sync**: Re-reads `.context/checkpoints/` and the active plan to ensure in-memory and disk states match.
3. **Autonomous Continuation**: If units remain, dispatches a follow-up turn (`deliverAs: "followUp"`), driving red-green-refactor cycles autonomously across turns until all units pass.
4. **Safety Valves**:
   - **Stop-The-Line**: Automatically pauses upon 3 consecutive failures on the same unit, preserving exact error context.
   - **50-Turn Safety Threshold**: Prevents runaway looping.
   - **Interactive Pause**: Hit `Esc` or type `pause` / `stop` anytime to safely suspend.
5. **Auto-Handover**: Automatically cascades into `/skill:04-review` once all units are verified green.

---

## 💡 Acknowledgments & References

The Compound Engineering workflow pipeline in this repository draws deep architectural inspiration and reference from:
- **[`@leing2021/super-pi`](https://github.com/leing2021/super-pi)**: Special thanks to `super-pi` for its pioneering design of Pi-native Compound Engineering pipelines, checkpoint resumes, and artifact management patterns. In this project, we re-architected the terminal interaction to unlock multi-select capabilities, introduced the **`00-next` router**, streamlined **`05-learn`**, and fully integrated **`@juicesharp/rpiv-ask-user-question`** for rich terminal UI dialogs.

---

## 📄 License

MIT License.