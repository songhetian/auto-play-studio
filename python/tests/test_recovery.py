"""崩溃恢复：引擎重启后把残留的「活着」状态安全复位为可重跑状态。

接缝：
- plan_recovery(instances)：纯决策，只把 LIVE 状态（running/paused/stopping/starting）
  标记为需恢复，目标 idle，保留进度。
- recover_instances(store)：用可注入的 RecoveryStore 落地，幂等。
- DbStore：走真实 SQLite。
- POST /api/instances/recover：HTTP 触发 + 返回恢复数量。
"""
from __future__ import annotations

from engine.recovery import (
    LIVE_STATES,
    RECOVERED_STATUS,
    DbStore,
    RecoveryPlan,
    plan_recovery,
    recover_instances,
)


class FakeStore:
    """测试用存储替身：记录被调用的动作，不碰真实 SQLite。"""

    def __init__(self, instances: list[dict]) -> None:
        self._instances = instances
        self.statuses: dict[str, str] = {i["id"]: i["status"] for i in instances}
        self.logs: list[tuple[str, str, str]] = []

    def load_instances(self) -> list[dict]:
        return [dict(i, status=self.statuses[i["id"]]) for i in self._instances]

    def set_status(self, instance_id: str, status: str) -> None:
        self.statuses[instance_id] = status

    def log(self, instance_id: str, message: str, level: str = "info") -> None:
        self.logs.append((instance_id, message, level))


def _inst(iid: str, status: str, done: int = 0, total: int = 0, name: str = "实例") -> dict:
    return {"id": iid, "name": name, "status": status, "progress_done": done, "progress_total": total}


# ── A：纯决策 ──────────────────────────────────────────────

def test_plan_recovery_only_flags_live_states():
    instances = [
        _inst("R1", "running"),
        _inst("P1", "paused"),
        _inst("S1", "stopping"),
        _inst("G1", "starting"),
        _inst("I1", "idle"),
        _inst("C1", "completed"),
        _inst("E1", "error"),
        _inst("A1", "armed"),
    ]
    plans = plan_recovery(instances)
    flagged = {p.instance_id for p in plans}
    # 只有 4 个「活着」的状态被标记，其余保持不动
    assert flagged == {"R1", "P1", "S1", "G1"}


def test_plan_recovery_target_is_idle_and_preserves_progress():
    instances = [_inst("R1", "running", done=5, total=10, name="批量发送")]
    plans = plan_recovery(instances)
    assert len(plans) == 1
    p = plans[0]
    assert p.instance_id == "R1"
    assert p.from_status == "running"
    assert p.to_status == RECOVERED_STATUS  # 复位成可重跑
    assert p.progress_done == 5  # 已完成进度不丢
    assert p.progress_total == 10


def test_plan_recovery_empty_when_nothing_live():
    instances = [_inst("I1", "idle"), _inst("C1", "completed"), _inst("E1", "error")]
    assert plan_recovery(instances) == []


# ── B：落地 + 幂等 ────────────────────────────────────────

def test_recover_instances_applies_and_logs():
    store = FakeStore([_inst("R1", "running", done=3, total=8, name="群发")])
    plans = recover_instances(store)
    assert store.statuses["R1"] == RECOVERED_STATUS
    # 记了一条 warn 级恢复日志，带上进度
    assert len(store.logs) == 1
    iid, msg, level = store.logs[0]
    assert iid == "R1"
    assert level == "warn"
    assert "3/8" in msg
    # 返回的计划与决策一致
    assert plans == [RecoveryPlan("R1", "群发", "running", RECOVERED_STATUS, 3, 8)]


def test_recover_instances_is_idempotent():
    store = FakeStore([_inst("R1", "running")])
    first = recover_instances(store)
    assert len(first) == 1
    # 再跑一次：状态已不是 LIVE，不应再产生动作
    second = recover_instances(store)
    assert second == []
    # 日志只记了一次
    assert len(store.logs) == 1


def test_recover_instances_ignores_terminal_states():
    store = FakeStore([_inst("I1", "idle"), _inst("E1", "error")])
    plans = recover_instances(store)
    assert plans == []
    assert store.logs == []


# ── B-integration：真实 SQLite 适配器 ──────────────────────

def test_recover_via_db_store(make_instance):
    iid = make_instance("rpa", {}, name="中断的群发")
    # 模拟崩溃：状态滞留 running，进度已跑到一半
    import json
    from engine import db

    with db.write() as c:
        c.execute(
            "UPDATE instances SET status='running', progress_done=4, progress_total=9 WHERE id=?",
            (iid,),
        )

    plans = recover_instances(DbStore())
    assert len(plans) == 1
    assert plans[0].instance_id == iid

    row = db.query("SELECT status, progress_done, progress_total FROM instances WHERE id=?", (iid,))[0]
    assert row["status"] == RECOVERED_STATUS  # 复位
    assert row["progress_done"] == 4  # 进度保留
    assert row["progress_total"] == 9

    logs = db.query("SELECT level, message FROM logs WHERE instance_id=?", (iid,))
    assert any(l["level"] == "warn" and "4/9" in l["message"] for l in logs)


def test_live_states_constant_is_complete():
    # 与 runner.ALLOWED_TRANSITIONS 里所有「非终态」对齐的契约快照
    assert LIVE_STATES == {"running", "paused", "stopping", "starting"}


# ── D：HTTP 端点 ───────────────────────────────────────────

def test_recover_endpoint_reconciles(client, make_instance):
    iid = make_instance("rpa", {}, name="残火")
    from engine import db

    with db.write() as c:
        c.execute(
            "UPDATE instances SET status='running', progress_done=2, progress_total=7 WHERE id=?",
            (iid,),
        )

    resp = client.post("/api/instances/recover")
    assert resp.status_code == 200
    body = resp.json()
    assert body["recovered"] == 1
    plan = body["plans"][0]
    assert plan["id"] == iid
    assert plan["from"] == "running"
    assert plan["to"] == RECOVERED_STATUS
    assert plan["done"] == 2
    assert plan["total"] == 7

    # 列表里该实例已是 idle，进度保留
    listed = [x for x in client.get("/api/instances").json() if x["id"] == iid][0]
    assert listed["status"] == RECOVERED_STATUS
    assert listed["done"] == 2
    assert listed["total"] == 7


def test_recover_endpoint_noop_when_clean(client, make_instance):
    make_instance("rpa", {}, name="干净的")
    resp = client.post("/api/instances/recover")
    assert resp.status_code == 200
    assert resp.json() == {"recovered": 0, "plans": []}


def test_recovery_summary_reflects_last_run(client, make_instance):
    iid = make_instance("rpa", {}, name="残火2")
    from engine import db

    with db.write() as c:
        c.execute("UPDATE instances SET status='paused', progress_done=1, progress_total=3 WHERE id=?", (iid,))

    # 触发恢复，结果被引擎记下
    client.post("/api/instances/recover")

    summary = client.get("/api/instances/recovery").json()
    assert summary["recovered"] == 1
    plan = summary["plans"][0]
    assert plan["id"] == iid
    assert plan["from"] == "paused"
    assert plan["done"] == 1
    assert plan["total"] == 3
