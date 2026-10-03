# 22 · 屏幕互斥（碰屏实例同一时刻只能跑一个）

Status: done
Priority: P0
Type: task
Blocked by: —

## 背景

用户提的问题：**「我只有一个屏幕，多开不会冲突吗？」** —— 对了一半，而且对的那一半是真缺口。

rpa / macro 靠模拟真人键鼠干活，作用于**当前焦点窗口**。一块屏幕同一时刻只能有一个在跑：
两个同时跑，第二个会把第一个的窗口顶掉焦点、抢鼠标 —— **而且不报错**，只会悄悄点错窗口、
把话发给错人。这是「模拟真人键鼠」这个手段的物理上限，不是实例模型的 bug。

**修之前引擎没有这道防线**：`runner.py` 的 `_RUNNER_LOCK` 只守 `_RUNNERS` 注册表，
键鼠路径上没有任何互斥 —— 两个 rpa 同时点「开始」，引擎会让它们并行跑，然后物理打架。

## 裁定

- **冲突的是「同时跑」，不是「多开」**。多份配置照常并存、照常多开，只是 start 要抢到屏幕。
  实例在单屏下的价值（配置保存、热键有落点、运行历史按作业归档）一点没少。
- **互斥范围 = `rpa` + `macro`**（`engine/screen_lock.py` 的 `SCREEN_TOOLS`）。
  logi（Playwright 独立浏览器）、cmp、kb、excel 不碰屏幕，多开是真并行，不参与。
- **monitor 刻意不占锁**：它只读屏、不抢键鼠，而且常驻盯屏是它的本职 ——
  若它也占锁，别的实例就永远跑不起来。代价是「rpa 跑批时监控可能误判」，
  这条提示留给 02/11（monitor 的命中动作 redesign）一起做。
- **抢不到要说出是谁占着**，不能只回状态码：用户得知道该去停哪一个。

## Seam

1. `engine/screen_lock.py` —— `acquire_or_raise(holder_id)` / `release` / `holder` /
   `is_screen_tool`。纯并发原语，不读库；`ScreenBusy` 带 `holder_id`。
2. `InstanceRunner.start()` —— 碰屏工具先抢锁再置 `starting`；抢不到抛 `ScreenBusy`
   （此刻状态一个字没改）；锁在 `_run` 的 `finally` 放，「点了开始但没跑起来」的路径就地补放。
3. `POST /instances/{iid}/control/start` —— 409 + 人话：`屏幕正被「{name}」占用：
   动键鼠的实例同一时刻只能跑一个，先停掉它或等它跑完`。

## 验收标准

- [x] 两个 rpa：第一个跑着时第二个 start 抛 `ScreenBusy`，且第二个状态仍是 `idle`
- [x] 第一个跑完 / 停止后，屏幕放出来，第二个能正常跑
- [x] 暂停**不**交出屏幕（用户暂停是为了等时机接着跑）
- [x] 接口层 409 的 detail 里有占着屏幕的实例名字
- [x] 不碰屏的工具（logi）依旧真并行 —— 原来的并发测试改用 logi 而不是删掉

## 涉及文件

- `python/engine/screen_lock.py`（新增）
- `python/engine/runner.py`（start 抢锁 / `_run` finally 放锁 / `_tool()`）
- `python/engine/main.py`（`ScreenBusy` → 409 人话）
- `python/tests/test_runner.py`（屏幕互斥三例；并发测试改用 logi）
- `python/tests/test_api.py`（接口层一例）

## Comments

- 前端零改动：`api.ts` 的 `failWith` 在工单 21 已改成透传引擎 detail，409 的人话会原样到界面。
- 反证过老测试：`test_two_instances_can_run_concurrently` 原来用**两个 rpa** 断言并行 ——
  正是这次判定为错误的行为。改成两个 logi，保留「进度与回写互不干扰」这条本意。
- 数字：后端 648（+4：3 runner + 1 api），全绿。
