# 🌟 pi-unifan-zh (Pi Chinese Extensions Collection & Monorepo)

A high-quality collection of Chinese-localized extensions and skills for **Pi Coding Agent**.

Supports both **All-in-One Bundle Installation** and **Individual Single-Package Installation**.

[中文文档 (Chinese Documentation)](./README_zh.md)

---

## 📁 Repository Structure

```text
pi-unifan-zh/
├── package.json              # Root bundle manifest (all-in-one install)
├── tsconfig.json             # TypeScript configuration
├── README.md                 # English Documentation
├── README_zh.md              # Chinese Documentation
├── extensions/               # 📦 Individual Extension Packages
│   ├── sessions/             # 📜 Dual-pane session manager with live preview (Chinese)
│   └── review/               # 🔍 Multi-agent parallel code review & gate arbiter (Chinese)
└── skills/                   # 🎯 Custom prompt skills library
```

---

## 🚀 Installation Guide

### Option A: All-in-One Bundle Install

#### 1. Via npm (Online):
```bash
pi install npm:@unifan/pi-unifan-zh
```

#### 2. Via GitHub (Online & Up-to-date):
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
# npm:
pi install npm:@unifan/pi-sessions-zh

# Local:
pi install D:/program/my/pi-unifan-zh/extensions/sessions
```

#### 2. Install `review` (AI Parallel Code Review):
```bash
# npm:
pi install npm:@unifan/pi-review-zh

# Local:
pi install D:/program/my/pi-unifan-zh/extensions/review
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

### 2. 🔍 `review` (AI Multi-Agent Code Review)
- **Commands**:
  - **`/review --lite`** ⭐ **(Recommended for daily development)**: Fast single-agent review pass in 3~5s, highly token-efficient.
  - **`/review`**: Full 5-agent parallel fan-out review with gatekeeper arbitration (ideal before PR merges).
  - **`/review <prompt>`**: Targeted review with custom focus.
  - **`/review-show`**: Re-render the most recent review report.
  - **`/review-agents`**: View reviewer agents and models status.
  - **`/review-config`**: Edit review configuration.
- **Features**:
  - 5 parallel AI specialist reviewers (`bugbot`, `security-review`, `claude-md-compliance`, `history-context`, `code-comments`).
  - 1 inline Gatekeeper AI (`gate`) that dedupes and filters false alarms (<8 confidence threshold).
  - **100% fluent Chinese report and finding descriptions**.

---

## 🔄 Updating Extensions

```bash
# Update all installed extensions:
pi update --extensions

# Or update specific extension:
pi update npm:@unifan/pi-unifan-zh
pi update git:github.com/821869798/pi-unifan-zh
```

---

## 📄 License

MIT License