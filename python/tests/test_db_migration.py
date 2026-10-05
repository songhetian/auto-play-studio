"""库结构迁移（对应 ADR-0001 的 `PRAGMA user_version` 约定）。

`hit_events` 的两个后加列（`is_read` / `snapshot`）以前是靠
`try/except OperationalError: pass` 补的：失败一律静默吞掉，
「早就迁过了」和「迁移真的炸了」根本分不出来。

这里钉住三件事：
- 老库能按版本逐级补齐列，并把 `user_version` 记到最新
- 重复迁移是幂等的（不会因为列已存在而报错）
- 与「列已存在」无关的失败必须抛出，不许再吞
"""
from __future__ import annotations

import sqlite3

import pytest

from engine import db


def _mem() -> sqlite3.Connection:
    """一条干净的内存连接，用来扮演「老库」。"""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    return c


def _cols(c: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in c.execute(f"PRAGMA table_info({table})")}


def _old_library(c: sqlite3.Connection) -> None:
    """造一个 v1 的老库：hit_events 只有最早那批列，没有 is_read / snapshot。"""
    c.execute(
        """
        CREATE TABLE hit_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            instance_id TEXT NOT NULL,
            tool        TEXT NOT NULL DEFAULT 'monitor',
            title       TEXT NOT NULL DEFAULT '',
            ts          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )
        """
    )
    c.execute("PRAGMA user_version = 1")


def test_测试库自身的_user_version_就是当前版本() -> None:
    """导入 db 时就会把库升到 SCHEMA_VERSION，这是全局不变量。"""
    with db.write() as c:
        v = c.execute("PRAGMA user_version").fetchone()[0]
    assert v == db.SCHEMA_VERSION


def test_老库迁移后版本与列都补齐() -> None:
    c = _mem()
    _old_library(c)
    assert _cols(c, "hit_events") == {"id", "instance_id", "tool", "title", "ts"}

    db._migrate(c)

    assert c.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    assert {"is_read", "snapshot", "disposition", "ack_at"} <= _cols(c, "hit_events")
    c.close()


def test_迁移是幂等的_重复跑不抛() -> None:
    """同一进程里重连、或启动被中断后重来，都不能因为列已存在而炸。"""
    c = _mem()
    _old_library(c)
    db._migrate(c)
    db._migrate(c)  # 第二次：user_version 已是最新，逐级都被跳过
    assert c.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    c.close()


def test_列已被手工补过时_放过重复列() -> None:
    """user_version 落后但列已经在了（有人手工 ALTER 过）：容忍 duplicate column。"""
    c = _mem()
    _old_library(c)
    c.execute("ALTER TABLE hit_events ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0")
    # 故意不写 user_version：迁移还得从 1 升上来，第 2 级会撞上重复列
    db._migrate(c)
    assert c.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    assert {"is_read", "snapshot", "disposition", "ack_at"} <= _cols(c, "hit_events")
    c.close()


def test_与重复列无关的失败必须抛出() -> None:
    """没有 hit_events 表时 ALTER 会报 "no such table"：这不是「早已迁过」，不许吞。"""
    c = _mem()
    c.execute("PRAGMA user_version = 1")
    with pytest.raises(sqlite3.OperationalError, match="no such table"):
        db._migrate(c)
    c.close()


def test_新库判定看_instances_表在不在() -> None:
    c = _mem()
    assert db._is_new_database(c) is True
    c.execute("CREATE TABLE instances (id TEXT PRIMARY KEY)")
    assert db._is_new_database(c) is False
    c.close()
