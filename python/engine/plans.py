"""方案（配置模板）：全局存一份，跨工具、跨实例复用。

方案是「配置模板层」，实例是「运行主体层」，两者**不双向同步**：
- 存进来的配置是一份**快照**，跟来源实例没有引用关系 —— 删实例方案还在，改实例方案不变。
- 以前「方案」只是 cmp 配置页上的一个按钮，写在 `uploads/<iid>/对比方案.json`，
  实例一删就没了；现在提到全局，任何工具都能存、任何实例都能套。

对外的唯一联系人是「新建实例时套一份过来」（见 main.create_instance 的 planId）。
"""
from __future__ import annotations

import copy
import json
import uuid
from typing import Any

from . import db


def _payload(row: dict[str, Any]) -> dict[str, Any]:
    """camelCase 只收敛在这一处（接口字段一律 camelCase）。"""
    return {
        "id": row["id"],
        "tool": row["tool"],
        "name": row["name"],
        "config": json.loads(row["config_json"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """以 base 为底，用 patch 覆盖；嵌套的 dict 逐层合并，不是整块替换。

    方案可以只写它关心的那几项（比如只存一个容差），整块替换会把默认配置里的
    hotkeys 一起抹掉，套出来的实例就是一份残缺配置。
    """
    out = dict(base)
    for k, v in patch.items():
        cur = out.get(k)
        # 深拷贝：不这么做的话，实例和方案会共用同一个嵌套对象，改一边动两边
        out[k] = deep_merge(cur, v) if isinstance(cur, dict) and isinstance(v, dict) else copy.deepcopy(v)
    return out


def create_plan(tool: str, name: str, config: dict[str, Any]) -> str:
    pid = f"p{uuid.uuid4().hex[:8]}"
    with db.write() as c:
        c.execute(
            "INSERT INTO plans(id, tool, name, config_json) VALUES (?,?,?,?)",
            (pid, tool, name, json.dumps(config, ensure_ascii=False)),
        )
    return pid


def list_plans(tool: str | None = None) -> list[dict[str, Any]]:
    """按创建顺序倒序（新建的在前）。

    排序列用 rowid 而不是时间：同一秒内建两条，`datetime('now','localtime')`
    只到秒，分不出先后，列表顺序会在刷新时跳来跳去。
    """
    sql = "SELECT * FROM plans"
    params: tuple = ()
    if tool:
        sql += " WHERE tool=?"
        params = (tool,)
    sql += " ORDER BY rowid DESC"
    return [_payload(r) for r in db.query(sql, params)]


def get_plan(plan_id: str) -> dict[str, Any] | None:
    r = db.query("SELECT * FROM plans WHERE id=?", (plan_id,))
    return _payload(r[0]) if r else None


def update_plan(
    plan_id: str,
    name: str | None = None,
    config: dict[str, Any] | None = None,
) -> bool:
    """只改传进来的那几项，没传的一律不动（改名不该把配置一起冲掉）。"""
    sets: list[str] = []
    params: list[Any] = []
    if name is not None:
        sets.append("name=?")
        params.append(name)
    if config is not None:
        sets.append("config_json=?")
        params.append(json.dumps(config, ensure_ascii=False))
    if not sets:
        return False
    sets.append("updated_at=datetime('now','localtime')")
    params.append(plan_id)

    with db.write() as c:
        cur = c.execute(f"UPDATE plans SET {', '.join(sets)} WHERE id=?", tuple(params))
    return cur.rowcount > 0


def delete_plan(plan_id: str) -> bool:
    with db.write() as c:
        cur = c.execute("DELETE FROM plans WHERE id=?", (plan_id,))
    return cur.rowcount > 0
