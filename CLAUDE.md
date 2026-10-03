# CLAUDE.md

## 项目

AutoPlay Studio —— 桌面自动化综合工具包。架构为「控制台（Launcher）+ 独立实例」：每个工具可多开实例，实例之间完全隔离、并行运行。

- 技术栈：Electron + React + React Router + React Query + Zustand + Zod + ECharts；自动化引擎为 Python（FastAPI + SQLite）
- 原型与方案：`designs/auto-play-toolkit/`（`页面设计 v5.html` 为最新原型，`设计方案.md` 为架构与业务规则）
- 实施顺序见 `docs/agents/domain.md` 与 `README.md`

## 开发约定

- 配置与执行分离：配置页只改数据，执行器只消费数据，二者不互相依赖
- 实例隔离：窗口绑定、方案指令、Excel、状态、日志、worker 每实例独立；图像库、全局设置、引擎连接共享
- 新增工具 = 写一个页面组件 + 在 `src/app/moduleRegistry.tsx` 注册一行；后端对应 `python/engine/tools/<tool>/`

## Agent skills

### Issue tracker

Issues 以本地 markdown 文件存放于 `.scratch/<feature-slug>/`。See `docs/agents/issue-tracker.md`.

### Triage labels

沿用默认五类角色标签（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文（single-context）：根目录 `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.
