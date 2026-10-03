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

**S6a ✅ 未读标记**（`tests/test_hit_events_unread.py`，5 例）
`hit_events` 加 `is_read`；`list_hit_events(unread_only=)` / `mark_hits_read(ids=None)` /
`unread_count()`；`GET /api/hit-events/unread-count` + `POST /api/hit-events/read`。
两条规矩：新事件默认未读（记录了却算已读 = 走开一趟回来什么都看不到）；
「全部标记已读」返回**本次真正被标记**的条数（已读的不重复算，否则角标翻倍）。
提前做是因为它是 S4 未读角标与 S7 事件列表页共用的地基。
**这是本单第一次真正的 schema 迁移**：`CREATE TABLE IF NOT EXISTS` 对已存在的库一字不改，
所以 `db.py` 加了 `_MIGRATIONS`（`ALTER TABLE ... ADD COLUMN`，失败即视为已有）。

**S5 ✅ IM 机器人 webhook**（`tests/test_notify_webhook.py`，11 例）
- `engine/notify/webhook.py`：`build_webhook_body(kind, payload)` 是独立 seam ——
  三家消息结构对外是硬契约（发错结构对方直接不显示且不报错），期望值按各家公开文档手写。
  企微 `{msgtype:markdown, markdown:{content}}` / 钉钉 `{msgtype:markdown, markdown:{title,text}, at:{isAtAll:false}}` /
  飞书 `{msg_type:text, content:{text}}`（**不加 `**`，飞书 text 不认 markdown**）。
  不认识的类型直接报错：宁可发不出去，也不发一堆对方解析不了的东西。
  发信用 stdlib `urllib` 而不是 requests —— 引擎要打成 sidecar，少一个三方依赖就少一处 hidden-import 的坑。
- 配置：`webhook.url` / `webhook.kind`；**启用但没填地址时不构造通道**（否则每次命中都记一条
  「地址没填」的失败，真正的失败会被淹掉）。
- 「测试发送」`POST /api/settings/notify/test`：**刻意绕过级别路由**，走所有启用的通道 ——
  它验的是通道本身配得对不对；受路由约束的话，用户配了 webhook 却因 alert 没路由到它而什么都不发，
  会以为自己填错了。失败原因原样回界面（不抛 500）。真发信器走 `Depends(webhook_poster)`，测试可覆盖
  （**依赖覆盖必须挂在 `api` 子应用上**）。

**S4 ✅ 桌面通知设备层**（`electron/notifications.ts` + `notifications.test.ts`，7 例 + 真机验收 10 项）
- 泵：`createNotifyPump({fetchOutbox, fetchUnread, show, setBadge, onError}, intervalMs)`。
  启动**立刻**拉一次（命中到弹窗的预算是 3 秒，不该先白等一个周期）；
  上一轮没回来不叠下一轮；引擎抖一下只记一笔、下一轮照常；未读数变了才设角标。
- 可测部分靠注入，设备层（真 toast / 角标）只人工验收。为跑这 7 例：
  vitest 的 `include` 加了 `electron/**/*.test.ts`，`tsconfig.electron.json` 里把测试 `exclude`
  （tsc 只认 CommonJS + types:node，编译 vitest 的测试会报错）。
- 主进程接线：`new Notification` + 点通知回到控制台；角标 `app.setBadgeCount`（macOS/Linux），
  **Windows 上它没有效果、做 overlay/托盘又需要先有图标资源**，所以 Windows 把未读数写进窗口标题
  （`AutoPlay 控制台 · 3 条未读`），任务栏上看得到。另设了 `app.setAppUserModelId`（打包后通知才显示应用名）。
- 真机验收 `.scratch/verify/run-notify-pump.sh`：引擎 8799 + **真 fetch 打真引擎**
  （URL / 响应结构 / 游标推进 / 停止后不再取全覆盖），触发路径用现成的
  `POST /api/settings/notify/test` → 桌面通道 → outbox → 泵。
  **真弹出 Windows toast 脚本抓不到，仍需人眼确认一次。**

**S6b ✅ 静音时段**（`tests/test_notify_quiet.py`，7 例）
- `engine/notify/quiet.py::in_quiet_window(cfg, now)`：跨天窗口（22:00→08:00，最常见的写法）单独有测试；
  起止相同 = 全天静音；**时间写错了宁可不静音**（静默静音是最坏的失败方式——用户会以为通知坏了）。
- 判定放在 `deliver(..., muted=)` 里而不是调用方：这里是通道的唯一出口，
  散落出去就会出现「桌面静音了、webhook 照发」这种半静音。
- 静音期间**事件照记、通道不发**，且 `notified` 写 `skip: 静音时段` 而不是留空 ——
  否则用户在事件列表里只看到「这条没通知」，分不清是静音还是发失败。
- 配置 `quiet:{enabled,from,to}`，默认关。

**接下来**（按序，一片一 seam）：
- S7 事件列表页面（前端，按实例 / 级别 / 工具 / 仅未读筛选 + 游标分页 + 全部标记已读）
  + 设置页的通知配置区块（通道启停 / 级别路由 / webhook 地址与类型 / 静音时段 + 测试发送）。
- 静音的**快捷键触发**（现在只有配置，没快捷键）。
- 顺带：22 的遗留提示「屏幕上有实例在跑批，监控可能误判」放这一单做。
