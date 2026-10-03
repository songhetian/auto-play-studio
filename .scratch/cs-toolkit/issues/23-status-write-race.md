# 23 · 停止后卡在「停止中」

Status: done
Priority: P0
Type: bug
Blocked by: —

## 背景

跑监控的用例偶发失败（约 1/8）：`runner.stop()` 之后等 5 秒，状态仍是 `stopping`。
对照实验（把改动撤掉再跑 10 次）确认**与当时的改动无关，是既有缺陷**。

## 定位

`InstanceRunner._set_status` 曾经是**先读后写两段式**：

```python
cur = self.status()                       # ① 读（独立的一次查询）
if next_status not in ALLOWED_TRANSITIONS.get(cur, set()):
    return False
with db.write() as c:                     # ② 写（另开一个事务）
    c.execute("UPDATE instances SET status=? ...")
```

①②之间是一个窗口。停实例时的真实交错（诊断脚本打出的轨迹）：

```
MainThread: idle -> starting = True
Thread-2:   starting -> running = True
Thread-2:   running -> stopping = True    ← worker 自己收尾
Thread-2:   stopping -> idle = True       ← 已经回到 idle
MainThread: running -> stopping = True    ← 主线程手里还是「running」这张旧快照
```

最后一步把「running → stopping」这个**当时已非法**的转换又写了一遍。
卡住之后界面再也点不动：`ALLOWED_TRANSITIONS["stopping"] == {"idle", "error"}`，
而这两个都不会自己发生 —— 实例既不动弹也不能重跑。

## 修复

检查与写放进**同一个事务**，并且用**写事务里那条连接**读当前状态：

```python
with db.write() as c:
    r = c.execute("SELECT status FROM instances WHERE id=?", (self.id,)).fetchone()
    cur = r["status"] if r else "idle"
    if next_status not in ALLOWED_TRANSITIONS.get(cur, set()):
        return False
    c.execute("UPDATE instances SET status=? ...")
```

写入是全局串行的（`db.write` 的 `_write_lock`），拿到写锁之后读到的必然是所有已提交的写入，
窗口消失。

## 验收标准

- [x] `tests/test_monitor.py::test_repeated_start_stop_always_ends_back_at_idle`
      连跑 20 轮 start→stop，每轮都必须回到 idle（修复前第 1 轮就卡住）
- [x] 诊断脚本 60 次不再复现（修复前 1–10 次必中）
- [x] 后端全量 677 passed，连续多轮稳定

## Comments

### 为什么回归测试写成「跑 20 轮」

竞态没法用一次调用稳定复现 —— 单轮命中率大约 10%~50%（取决于机器负载）。
20 轮几乎必然命中，而修好之后每一轮都是确定性的（检查与写不再分离），
所以这个测试不会假失败，只会真失败。

诊断脚本（`python/repro_stop_hang.py`）用完即删；
它把 `_set_status` 包一层记录每次转换（含读到的旧值、结果、线程名），是这次定位的关键。
