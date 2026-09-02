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
├── extensions/               # 📦 Individual Extension Packages
│   ├── sessions/             # 📜 ① Dual-pane session manager with live preview (Chinese)
│   ├── review/               # 🔍 ② AI multi-agent code review suite (Daily/Lite/Perf/Full)
│   └── commit/               # 📦 ③ Intelligent Conventional Commits assistant (Chinese)
└── skills/                   # 🎯 Custom prompt skills library
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

#### 1. Install `sessions` (Session Manager with TUI Preview):
```bash
pi install npm:@unifan/pi-sessions-zh
```

#### 2. Install `review` (AI Parallel Code Review Suite):
```bash
pi install npm:@unifan/pi-review-zh
```

#### 3. Install `commit` (Intelligent Git Commit Assistant):
```bash
pi install npm:@unifan/pi-commit-zh
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
- **Architecture**:
  - Re-architected following the battle-tested **Codex & pi-agent-extensions** design (by Armin Ronacher @mitsuhiko).
  - **Native Session Tree Branch Isolation**: Completely eliminates multi-subagent WebSocket dropouts, proxy streaming errors, and timeouts. Rock-solid stability on any model (GPT, Claude, DeepSeek, GLM, etc.).
- **Commands**:
  - **`/review`** 🔍: Launches interactive Chinese TUI menu with 6 review modes:
    - ① `Review uncommitted changes` (staged + unstaged working tree, smart default)
    - ② `Review against base branch` (auto merge-base calculation against main/master/dev)
    - ③ `Review specific commit` (search and pick from recent commits)
    - ④ `Review GitHub Pull Request` (auto local checkout via gh CLI)
    - ⑤ `Review folder/files snapshot` (full snapshot audit, non-diff)
    - ⑥ `Custom review focus` (concurrency, GC, security, API contracts)
  - **`/review-lite`** ⭐: Directly audits current uncommitted changes without menu prompts.
  - **`/end-review`** 🏁:
    - Automatically structures review findings into P0~P3 action items.
    - Seamlessly jumps back to the original working branch and pre-fills the editor with fix instructions!
- **Standards & Guidelines**:
  - **P0~P3 Strict Severity Tags**: Blocker, Urgent, Normal, Low.
  - **Zero Speculation & Grounded in Diff**: Every finding is backed by source evidence.
  - **Custom Guidelines**: Automatically respects repo-level `REVIEW_GUIDELINES.md`, `AGENTS.md`, or `CLAUDE.md`.

---

### 3. 📦 `commit` (Intelligent Conventional Commits Assistant)
- **Commands**:
  - **`/commit`**: Analyzes `git diff`, generates standardized Conventional Commits in fluent Chinese, and commits in 1 second.
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
  - **Unpushed Commits Sync**: Automatically pushes unpushed local commits even if the working tree is clean.

---

## 📄 License

MIT License.