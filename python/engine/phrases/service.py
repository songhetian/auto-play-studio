# -*- coding: utf-8 -*-
"""话术库的业务逻辑。

设计取舍：
- **标题唯一**：用户改话术是"覆盖同一条"，不是"越积越多"。列表里出现两条同名，
  客服根本不知道该用哪条。
- **按使用次数排序**：一天用几十次同一句是常态，把常用的沉在列表深处等于制造工作量。
- **占位符原样存**：``{客户名}`` 在库里保持模板形态，替换发生在"发给某个客户"的时刻，
  否则同一句话没法复用到不同客户。
"""
from __future__ import annotations

from .. import db

MAX_TITLE = 60
MAX_BODY = 2000


def _clean(value: str) -> str:
    return (value or "").strip()


def _validate(title: str, body: str) -> None:
    if not title:
        raise ValueError("标题不能为空")
    if not body:
        raise ValueError("话术内容不能为空")
    if len(title) > MAX_TITLE:
        raise ValueError("标题太长了（最多 %d 字）" % MAX_TITLE)
    if len(body) > MAX_BODY:
        raise ValueError("话术太长了（最多 %d 字）" % MAX_BODY)


def _row_to_dict(row) -> dict:
    """字段名统一 camelCase，与前端 `Phrase` 类型一致。"""
    return {
        "id": row["id"],
        "title": row["title"],
        "body": row["body"],
        "category": row["category"],
        "usedCount": row["used_count"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def list_phrases(q: str = "", category: str = "") -> list[dict]:
    """常用在前；同次数按最近更新的在前（刚改过的更可能就是要用的那条）。"""
    sql = "SELECT * FROM phrase WHERE 1=1"
    args: list = []
    q = _clean(q)
    if q:
        # 标题与正文都搜：客服记得的是"那句说辞"，未必记得标题
        # ESCAPE 让 like_literal 转义过的 % / _ 变成字面量
        sql += " AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')"
        args += [db.like_literal(q)] * 2
    category = _clean(category)
    if category:
        sql += " AND category = ?"
        args.append(category)
    sql += " ORDER BY used_count DESC, updated_at DESC, id DESC"
    return [_row_to_dict(r) for r in db.query(sql, tuple(args))]


def categories() -> list[str]:
    """分类清单（去重、忽略空），给前端做筛选栏。"""
    rows = db.query(
        "SELECT DISTINCT category FROM phrase WHERE TRIM(category) <> '' ORDER BY category"
    )
    return [r["category"] for r in rows]


def upsert(title: str, body: str, category: str = "") -> dict:
    """新建或覆盖（同标题）。返回落库后的那条。"""
    title, body, category = _clean(title), body.strip(), _clean(category)
    _validate(title, body)

    existing = db.query("SELECT id FROM phrase WHERE title = ?", (title,))
    if existing:
        with db.write() as c:
            c.execute(
                "UPDATE phrase SET body=?, category=?, updated_at=datetime('now','localtime') WHERE id=?",
                (body, category, existing[0]["id"]),
            )
        pid = existing[0]["id"]
    else:
        with db.write() as c:
            cur = c.execute(
                "INSERT INTO phrase(title, body, category) VALUES (?,?,?)",
                (title, body, category),
            )
            pid = cur.lastrowid
    return get(pid)


def get(pid: int) -> dict:
    rows = db.query("SELECT * FROM phrase WHERE id = ?", (pid,))
    if not rows:
        raise KeyError("话术不存在")
    return _row_to_dict(rows[0])


def update(pid: int, title: str | None = None, body: str | None = None, category: str | None = None) -> dict:
    cur = get(pid)
    new_title = _clean(title) if title is not None else cur["title"]
    new_body = body.strip() if body is not None else cur["body"]
    new_cat = _clean(category) if category is not None else cur["category"]
    _validate(new_title, new_body)
    with db.write() as c:
        c.execute(
            "UPDATE phrase SET title=?, body=?, category=?, updated_at=datetime('now','localtime') WHERE id=?",
            (new_title, new_body, new_cat, pid),
        )
    return get(pid)


def remove(pid: int) -> None:
    if not db.query("SELECT id FROM phrase WHERE id = ?", (pid,)):
        raise KeyError("话术不存在")
    with db.write() as c:
        c.execute("DELETE FROM phrase WHERE id = ?", (pid,))


def mark_used(pid: int) -> dict:
    """用一次就 +1。发出去的动作本身就是最好的"常用度"信号。"""
    get(pid)
    with db.write() as c:
        c.execute("UPDATE phrase SET used_count = used_count + 1 WHERE id = ?", (pid,))
    return get(pid)
