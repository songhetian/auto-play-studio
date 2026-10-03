# ADR-0001：本地存储采用 SQLite（WAL），配置另存 JSON

- 状态：已接受
- 日期：2026-10-01

## 背景

应用打包为本地桌面程序（Electron + Python 引擎），无服务端、需离线可用、随安装包分发。需要持久化：

- 实例配置（窗口绑定、列映射、指令序列）
- 运行状态与进度（可崩溃恢复）
- 每行执行结果（成功 / 失败 / 失败原因 / 耗时）
- 运行日志（量大、需审计）
- 物流单号查询缓存（避免重复查询）

## 决策

1. **SQLite（stdlib `sqlite3`，开启 WAL）作为主存储**：零配置、单文件、无独立进程、随应用分发、离线可用；WAL 下"多实例 worker 各写各的"并发足够。
2. **配置另存 JSON**：方案需导出/分享/版本对照，JSON 人类可读可 diff；SQLite 只存状态与运行时数据。
3. **图像资产**：文件存磁盘（`assets/images/`），元数据（名称、尺寸、阈值、用途标签）入库，避免库文件膨胀。
4. 日志同时写 SQLite 与滚动文件，库内只保留最近 N 条用于界面展示。

## 理由

- 替代方案 A：纯 JSON/文件 —— 无法高效查询与增量写入，日志与行结果会失控
- 替代方案 B：嵌入式服务端数据库（Postgres/MySQL） —— 需安装与运维，违背"开箱即用"
- 替代方案 C：LevelDB/IndexedDB —— 生态与查询能力弱于 SQLite，Python 侧不便共享

## 约束与注意事项

- 单进程多连接写入会遇 `database is locked`：统一由引擎侧的写入队列串行化，并设 `busy_timeout`
- 数据库文件放用户数据目录（`app.getPath('userData')`），**不放安装目录**，避免升级/权限问题覆盖
- 备份：执行前可选备份 SQLite 与 Excel
- 迁移：schema 变更用 `PRAGMA user_version` + 迁移脚本，不用重量级 ORM 迁移工具

## 表结构（初版）

```
instances(id, tool, name, config_json, status, progress_done, progress_total, created_at, updated_at)
runs(id, instance_id, started_at, finished_at, status, stats_json)
rows(id, run_id, row_no, key_value, status, message, duration_ms)
logs(id, instance_id, ts, level, message)
image_assets(id, name, path, width, height, threshold, tag, created_at)
waybill_cache(no, company, status, signed_at, trace, updated_at)
```
