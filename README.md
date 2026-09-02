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

### 2. 🔍 `review` (AI Code Review Suite)
- **Review Modes**:
  - **`/review-lite`** ⭐ **(Recommended for daily development)**: Fast single-agent review pass in 2~3s, highly token-efficient.
  - **`/review-perf`** 🔥 **(Performance & Benchmark Reviewer)**: Deep-dive inspection for GC allocation, hot loops, algorithmic complexity, and benchmark probes.
  - **`/review`** 🔍 **(Daily 3-Expert Review)**: Bugbot + Security + Compliance + Gatekeeper with low latency.
  - **`/review-full`** 🏥 **(Full 6-Expert Consultation)**: Full multi-agent parallel audit (ideal for major releases and PR merges).
- **Utility Commands**:
  - **`/review-show`**: Re-render the most recent review report.
  - **`/review-agents`**: View reviewer agents and models status.
  - **`/review-config`**: Edit review configuration.
- **Key Features**:
  - **Model Inheritance**: Gate automatically inherits the active session model (`inherit`), avoiding missing model errors.
  - **Fault Tolerance & Auto-Retry**: Automatically retries on transient stream drops and preserves all completed reviewer findings even if the gate fails.
  - **100% Fluent Chinese Output**.

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