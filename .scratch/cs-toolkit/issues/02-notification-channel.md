# 02 · 通知通道与命中事件列表

Status: in-progress
Priority: P0
Type: task
Blocked by: —

## 背景

这是原任务清单里的 `#5 命中声音告警钩子` 与 `#6 独立命中事件列表`，本轮被认定为**一半功能的前置**。

现状：`monitor` 只做「记录命中」（`GET /api/instances/{iid}/monitor-hits`），
**没有「命中了怎么通知人」**。所以：

- 提醒类现在只有触发，没有出口 → 提醒类全部、触发器、定时日报、差评哨兵都卡在这里
- 命中事件没有独立模型，只挂在实例的运行记录下，无法跨实例检索

另外 `monitor` 是常驻盯屏的，现实中没人会一直开着实例窗口等它命中。
**不解决通知，监控类工具在生产里就是没用的。**

## 目标

### 1. 通知通道

| 通道 | 说明 |
| --- | --- |
| 桌面通知 | Electron `Notification`，主力通道 |
| 托盘 | 角标 + 托盘菜单未读数 |
| 声音 | 可换音效，可静音时段 |
| IM webhook | 企微/钉钉/飞书机器人 webhook，走 HTTP |
| 邮件 | 兜底，低频用 |

要求：
- 通道可逐条启用/停用，可选择「哪些级别走哪些通道」
- **通知失败绝不能影响监控本身** —— 失败降级为「只记录 + 在事件列表里标失败」，不能让盯屏断掉
- 键盘可静音（开会/午休），静音期间的命中不丢，只是不弹

### 2. 独立命中事件

命中事件需要独立模型，能跨实例检索：

```
{ id, instanceId, tool, ruleId, matchedBy, level, title, detail, evidencePath, at, notified: {通道: ok|fail} }
```

`matchedBy` 字段为定位器抽象预留（见 `spec.md` 二节）：记录这次是靠元素还是靠图片命中的 ——
**否则用户无法判断自己的规则可不可靠。**

## 验收标准

- [ ] 命中后 3 秒内可见通知（桌面 + 声音）
- [ ] 通道可逐条配置启停；IM webhook 可填 URL 并「测试发送」
- [ ] 通知失败不影响监控主流程，失败原因记在事件里
- [ ] 事件列表可按实例 / 时间 / 级别 / 工具筛选，可分页
- [ ] 未读角标与「全部标记已读」
- [ ] 静音开关在窗口和快捷键都能触发，静音期间命中不丢

## 涉及文件

- `python/engine/monitor.py`
- `python/engine/main.py`（事件 API）
- `python/engine/db.py`（事件表）
- `electron/main.ts`（通知、托盘、角标）
- `electron/preload.ts`
- `src/modules/instance/RunPage.tsx`
- 新增事件列表页面

## Comments

### 落地方案与切片（2026-10-02 起）

分层：`engine/notify/` —— `model.py`（`NotifyPayload` + `Channel` 协议）与 `dispatch.py`
（按级别路由 + 失败不传染）。通道实现以后各自一个文件，事件层只认 payload。

**S1 ✅ 分发器**（`tests/test_notify.py`，5 例，先红后绿）
seam = `deliver(payload, channels, routing)`，返回 `{通道名: 'ok' | 'fail: 原因'}`。
规矩：级别没配通道就**不碰**（结果里也不出现，免得读成「发了但没成」）；
某通道炸了记原因继续发下一个；调用方把结果原样写进事件的 `notified`。
`level` 刻意只有 info / warn / alert 三档 —— 档位一多「哪些级别走哪些通道」就没法配了。

**S2 ✅ 命中事件模型**（`tests/test_hit_events.py`，7 例，先红后绿）
`monitor_hits` → `hit_events`，**单一真源**：`record_monitor_hit` 只是它的一种写法
（image 命中 / alert 级别），运行详情页那四个字段（assetId/similarity/rect/ts）原地不动。
跨实例检索 `list_hit_events(instance_id, tool, level, limit, before_id)`；
`GET /api/hit-events` 同参。**没做迁移**：开发库与打包应用 userData 库的 `monitor_hits` 都是 0 行。
时间筛选刻意不开独立参数 —— `id` 序就是时间序，游标翻页够用；真要「最近 N 小时」再加 `since`。
`evidencePath` 也暂不开：还没有消费方，开了就是个假字段。

**S3 ✅ 通道接线**（`tests/test_notify_config.py` 5 例 + `tests/test_notify_report.py` 5 例
+ `tests/test_notify_outbox.py` 5 例）
- 配置：`settings` 表一行 `notify`（`channels` 启停 + `routing` 每级别走哪些通道），
  `GET/PUT /api/settings/notify`，没配过也给一套能用的默认（否则命中了却一条都不发）。
  合入语义（配置页每次只提交一块），不认识的级别直接丢掉而不是当成「全部通道都发」。
- 接线：`engine/notify/report.py::report_hit` 是「命中 → 通知」的唯一入口
  （记事件 → 组 payload → `deliver` → 结果写回**这一条**事件）。监控分支改调它。
- 出口：引擎是 sidecar 弹不了 Windows 通知，且监控常驻盯屏、没人一直开着实例窗口，
  所以桌面通道把通知放进 `engine/notify/outbox.py`，**由 Electron 主进程轮询**
  `GET /api/notifications/outbox?since=` 取走并真弹（窗口关了也收得到）。
- 声音**不做成全局通道**：monitor 已有实例级 `alertSound`，同一件事两块开关是假字段。

**接下来**（按序，一片一 seam）：
- S4 桌面通知的**设备层**：Electron 主进程轮询 outbox → `Notification` 弹窗 + 托盘角标
  —— 只人工验收（引擎侧已在 S3 测完）。
- S5 IM webhook 通道（企微/钉钉/飞书），可「测试发送」（webhook URL 这时才进配置）。
- S5 IM webhook 通道（企微/钉钉/飞书），可「测试发送」。
- S6 静音时段 + 未读/全部已读。
- S7 事件列表页面（前端，可多开筛选）。
- 顺带：22 的遗留提示「屏幕上有实例在跑批，监控可能误判」放这一单做。
