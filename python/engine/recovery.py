"""崩溃恢复：引擎重启后把残留的「活着」状态安全复位。

背景：InstanceRunner 只活在内存（runner._RUNNERS）。引擎崩溃重启后，内存里的
运行器全没了，但 DB 的 instances.status 还停在 running/paused/stopping/starting——
这些状态是假的，没有线程在跑。本模块在启动时对账，把它们复位成可重跑状态，
并保留已完成的进度（progress_done/total 本来就在 DB 里）。

设计：
- plan_recovery() 是纯决策：输入实例行，输出要纠正的计划，不碰 IO，便于单测。
- recover_instances(store) 通过可注入的 RecoveryStore 落地，幂等。
- DbStore 是走真实 SQLite 的适配器；main 在 lifespan 启动时调用 recover_on_startup()。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from . import db

#: 表示「有活线程在跑」的状态。引擎重启后这些状态都是假的，必须纠正。
#: 与 runner.ALLOWED_TRANSITIONS 里所有非终态对齐。
LIVE_STATES = {"running", "paused", "stopping", "starting"}

#: 纠正后的目标状态：保留已完成进度，用户在控制台重新点「开始」即可续跑
#: （RPA 的 skipSuccess 会跳过已成功的行，不会重复发送）。
RECOVERED_STATUS = "idle"


@dataclass
class RecoveryPlan:
    instance_id: str
    name: str
    from_status: str
    to_status: str
    progress_done: int
    progress_total: int


@runtime_checkable
class RecoveryStore(Protocol):
    """恢复落地所需的最小存储接口，便于测试注入假实现。"""

    def load_instances(self) -> list[dict]: ...

    def set_status(self, instance_id: str, status: str) -> None: ...

    def log(self, instance_id: str, message: str, level: str = "info") -> None: ...


def plan_recovery(instances: list[dict]) -> list[RecoveryPlan]:
    """纯决策：只把 LIVE 状态标记为需恢复，其余状态原样保留。"""
    plans: list[RecoveryPlan] = []
    for inst in instances:
        st = inst.get("status", "idle")
        if st in LIVE_STATES:
            plans.append(
                RecoveryPlan(
                    instance_id=inst["id"],
                    name=inst.get("name", ""),
                    from_status=st,
                    to_status=RECOVERED_STATUS,
                    progress_done=int(inst.get("progress_done") or 0),
                    progress_total=int(inst.get("progress_total") or 0),
                )
            )
    return plans


def recover_instances(store: RecoveryStore) -> list[RecoveryPlan]:
    """落地对账：复位每个残留的 live 实例并记日志。幂等——再跑一次不再产生动作。"""
    plans = plan_recovery(store.load_instances())
    for p in plans:
        store.set_status(p.instance_id, p.to_status)
        store.log(
            p.instance_id,
            f"引擎重启：实例「{p.name}」从「{p.from_status}」恢复为「{p.to_status}」，"
            f"已完成 {p.progress_done}/{p.progress_total} 行",
            "warn",
        )
    return plans


class DbStore:
    """走真实 SQLite 的 RecoveryStore 适配器。"""

    def load_instances(self) -> list[dict]:
        return db.query("SELECT id, name, status, progress_done, progress_total FROM instances")

    def set_status(self, instance_id: str, status: str) -> None:
        with db.write() as c:
            c.execute(
                "UPDATE instances SET status=?, updated_at=datetime('now','localtime') WHERE id=?",
                (status, instance_id),
            )

    def log(self, instance_id: str, message: str, level: str = "info") -> None:
        db.log(instance_id, message, level)


def recover_on_startup() -> list[RecoveryPlan]:
    """引擎启动时调用：把上次崩溃残留的 live 状态复位，并记录结果供前端展示。"""
    global _last_recovery
    _last_recovery = recover_instances(DbStore())
    return _last_recovery


#: 最近一次恢复的结果（通常是引擎启动那次）。前端加载时读它来展示「恢复了什么」。
_last_recovery: list[RecoveryPlan] = []


def recent_recoveries() -> list[RecoveryPlan]:
    """返回最近一次恢复计划，供 GET /api/instances/recovery 展示横幅。"""
    return _last_recovery
