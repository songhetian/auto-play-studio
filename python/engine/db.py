"""SQLite 存储层。

选型见 docs/adr/0001-sqlite-for-local-storage.md：
- WAL 模式 + 写入串行化，避免多 worker 并发写时的 database is locked
- 配置以 JSON 存 instances.config_json（可导出分享），状态与结果走表
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from typing import Any, Iterator

DB_PATH = os.environ.get("AUTOPLAY_DB", os.path.join(os.getcwd(), "autoplay.db"))

_write_lock = threading.Lock()
_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS instances (
    id            TEXT PRIMARY KEY,
    tool          TEXT NOT NULL,
    name          TEXT NOT NULL,
    config_json   TEXT NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'idle',
    progress_done INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL,
    started_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    finished_at TEXT,
    status      TEXT NOT NULL DEFAULT 'running',
    stats_json  TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS rows (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER NOT NULL,
    row_no      INTEGER NOT NULL,
    key_value   TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'wait',
    message     TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rows_run ON rows(run_id);

CREATE TABLE IF NOT EXISTS logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL,
    ts          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    level       TEXT NOT NULL DEFAULT 'info',
    message     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_instance ON logs(instance_id, id);

CREATE TABLE IF NOT EXISTS image_assets (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL,
    width      INTEGER NOT NULL DEFAULT 0,
    height     INTEGER NOT NULL DEFAULT 0,
    threshold  REAL NOT NULL DEFAULT 0.85,
    tag        TEXT NOT NULL DEFAULT '按钮类',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS waybill_cache (
    no         TEXT PRIMARY KEY,
    company    TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT '',
    signed_at  TEXT NOT NULL DEFAULT '',
    trace      TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 全局设置（影响执行的配置落这里，纯界面偏好才走 localStorage）。
-- 现在只有一行 notify：它决定命中后发不发、发到哪。
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 命中事件：所有工具的「命中」都记在这里，跨实例可检索（工单 02）。
-- 以前只有 monitor_hits（按实例挂在运行记录下，跨实例查不到），
-- 现在它是唯一的写入点，monitor_hits 的读写只是它的一种写法（见下方函数）。
CREATE TABLE IF NOT EXISTS hit_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL,
    tool        TEXT NOT NULL DEFAULT 'monitor',
    rule_id     TEXT NOT NULL DEFAULT '',
    matched_by  TEXT NOT NULL DEFAULT 'image',  -- 靠什么命中的：image / ocr / keyword …
    level       TEXT NOT NULL DEFAULT 'alert',  -- info / warn / alert，决定发哪些通道
    title       TEXT NOT NULL DEFAULT '',
    detail      TEXT NOT NULL DEFAULT '',
    similarity  REAL,
    rect        TEXT,                           -- JSON [x,y,w,h] 或 NULL
    notified    TEXT,                           -- JSON：逐通道发送结果 {"desktop":"ok"}
    is_read     INTEGER NOT NULL DEFAULT 0,     -- 已读标记（托盘角标 / 事件列表页）
    ts          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_hit_events_instance ON hit_events(instance_id, id);
CREATE INDEX IF NOT EXISTS idx_hit_events_level ON hit_events(level, id);

-- 知识库（kb）：文件夹登记 / 文档 / 段落 / 搜索历史（见 engine/kb/）
-- 段落单独成表而不是塞进文档行：搜索命中后要按 doc 取片段，
-- 而建索引时又只需要一遍扫过去，两件事都靠这张表的一个索引搞定。
CREATE TABLE IF NOT EXISTS kb_folder (
    path     TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    saved_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS kb_doc (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    path       TEXT NOT NULL UNIQUE,
    file_name  TEXT NOT NULL,
    file_type  TEXT NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    mtime      REAL NOT NULL DEFAULT 0,
    truncated  INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS kb_para (
    doc_id INTEGER NOT NULL,
    idx    INTEGER NOT NULL,
    line   INTEGER NOT NULL,
    text   TEXT NOT NULL,
    PRIMARY KEY (doc_id, idx)
);

CREATE TABLE IF NOT EXISTS kb_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    query        TEXT NOT NULL UNIQUE,
    result_count INTEGER NOT NULL DEFAULT 0,
    used_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def conn() -> sqlite3.Connection:
    """每线程一条连接。

    多个实例各自跑在自己的 worker 线程里；共用一条连接会被并发使用，
    sqlite3 会抛 InterfaceError（bad parameter or other API misuse）。
    """
    c: sqlite3.Connection | None = getattr(_local, "conn", None)
    if c is None:
        c = _connect()
        _local.conn = c
    return c


#: 后加的列：`CREATE TABLE IF NOT EXISTS` 对已经存在的库一个字都不会改，
#: 所以新列必须显式补。失败就当已经有了（新库由 SCHEMA 直接建好）。
_MIGRATIONS = (
    "ALTER TABLE hit_events ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0",
)

# 导入时先建表（用一条临时连接，之后各线程自建连接）
_bootstrap = _connect()
_bootstrap.executescript(SCHEMA)
for _stmt in _MIGRATIONS:
    try:
        _bootstrap.execute(_stmt)
    except sqlite3.OperationalError:
        pass
_bootstrap.commit()
_bootstrap.close()


@contextmanager
def write() -> Iterator[sqlite3.Connection]:
    """写入事务：全局串行化，避免多实例并发写时的 database is locked。"""
    c = conn()
    with _write_lock:
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise


def query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    cur = conn().execute(sql, params)
    return [dict(r) for r in cur.fetchall()]


def log(instance_id: str, message: str, level: str = "info") -> None:
    with write() as c:
        c.execute("INSERT INTO logs(instance_id, level, message) VALUES (?,?,?)", (instance_id, level, message))
        # 库内只保留最近 2000 条，避免无限增长
        c.execute(
            "DELETE FROM logs WHERE instance_id=? AND id NOT IN "
            "(SELECT id FROM logs WHERE instance_id=? ORDER BY id DESC LIMIT 2000)",
            (instance_id, instance_id),
        )


def save_config(instance_id: str, config: dict[str, Any]) -> None:
    with write() as c:
        c.execute(
            "UPDATE instances SET config_json=?, updated_at=datetime('now','localtime') WHERE id=?",
            (json.dumps(config, ensure_ascii=False), instance_id),
        )


def get_config(instance_id: str) -> dict[str, Any]:
    r = query("SELECT config_json FROM instances WHERE id=?", (instance_id,))
    return json.loads(r[0]["config_json"]) if r else {}


#: 通知级别只有三档。档位一多，「哪些级别走哪些通道」就没法配了。
NOTIFY_LEVELS = ("info", "warn", "alert")
#: 通知配置的默认值：没配过也要有一套能用的，否则命中了却一条通知都不发。
DEFAULT_NOTIFY_CONFIG = {
    "channels": {"desktop": True, "webhook": False},
    "routing": {"info": [], "warn": ["desktop"], "alert": ["desktop"]},
    # 没填地址就是不发：默认别指向任何地方
    "webhook": {"url": "", "kind": "wecom"},
    # 静音：默认关。默认给一段「下班后」只是让人一眼看懂这两个框填什么
    "quiet": {"enabled": False, "from": "22:00", "to": "08:00"},
}


def _merged_notify_config(saved: dict[str, Any]) -> dict[str, Any]:
    """用默认值补全配置，并挡掉不认识的通道名 / 级别。

    不认识的级别直接丢掉而不是当成「全部通道都发」——
    宁可这条静默，也不要把弹窗刷爆。
    """
    cfg: dict[str, Any] = {k: dict(v) for k, v in DEFAULT_NOTIFY_CONFIG.items()}
    channels = saved.get("channels")
    if isinstance(channels, dict):
        for name, on in channels.items():
            if name in cfg["channels"]:
                cfg["channels"][name] = bool(on)
    routing = saved.get("routing")
    if isinstance(routing, dict):
        for level in NOTIFY_LEVELS:
            wanted = routing.get(level)
            if isinstance(wanted, list):
                cfg["routing"][level] = [n for n in wanted if n in cfg["channels"]]
    wh = saved.get("webhook")
    if isinstance(wh, dict):
        from .notify.webhook import WEBHOOK_KINDS

        cfg["webhook"]["url"] = str(wh.get("url") or "")
        if wh.get("kind") in WEBHOOK_KINDS:
            cfg["webhook"]["kind"] = wh["kind"]
    quiet = saved.get("quiet")
    if isinstance(quiet, dict):
        cfg["quiet"]["enabled"] = bool(quiet.get("enabled"))
        for key in ("from", "to"):
            value = quiet.get(key)
            if isinstance(value, str):
                cfg["quiet"][key] = value
    return cfg


def get_notify_config() -> dict[str, Any]:
    """读取通知配置（没配过就给默认值）。"""
    rows = query("SELECT value_json FROM settings WHERE key='notify'")
    saved = json.loads(rows[0]["value_json"]) if rows else {}
    return _merged_notify_config(saved)


def save_notify_config(patch: dict[str, Any]) -> dict[str, Any]:
    """合入一块配置，返回合并后的完整配置。

    配置页每次只提交当前那一块（比如只改路由），所以这里是「合」不是「替」，
    没提交的字段保持原样（缺的走默认）。
    """
    merged = _merged_notify_config({**get_notify_config(), **(patch or {})})
    with write() as c:
        c.execute(
            "INSERT INTO settings(key, value_json, updated_at) VALUES ('notify',?,datetime('now','localtime')) "
            "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
            (json.dumps(merged, ensure_ascii=False),),
        )
    return merged


HIT_EVENT_FIELDS = (
    "id, instance_id, tool, rule_id, matched_by, level, title, detail, similarity, rect, notified, is_read, ts"
)


def _hit_payload(r: dict[str, Any]) -> dict[str, Any]:
    """库内行 → 接口字段（camelCase 只在这里换算一次）。"""
    return {
        "id": r["id"],
        "instanceId": r["instance_id"],
        "tool": r["tool"],
        "ruleId": r["rule_id"],
        "matchedBy": r["matched_by"],
        "level": r["level"],
        "title": r["title"],
        "detail": r["detail"],
        "similarity": r["similarity"],
        "rect": json.loads(r["rect"]) if r["rect"] else None,
        "notified": json.loads(r["notified"]) if r["notified"] else {},
        "read": bool(r["is_read"]),
        "ts": r["ts"],
    }


def record_hit_event(
    instance_id: str,
    tool: str,
    rule_id: str = "",
    matched_by: str = "image",
    level: str = "alert",
    title: str = "",
    detail: str = "",
    similarity: "float | None" = None,
    rect: "list[int] | None" = None,
    notified: "dict[str, str] | None" = None,
) -> int:
    """记一次命中事件，返回事件 id。

    `notified` 由调用方把分发结果（逐通道 ok/fail）回写进来，
    这样事件列表能回答「这条到底通知出去没有」。
    """
    with write() as c:
        cur = c.execute(
            "INSERT INTO hit_events(instance_id, tool, rule_id, matched_by, level, title, detail, "
            "similarity, rect, notified) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                instance_id,
                tool,
                rule_id,
                matched_by,
                level,
                title,
                detail,
                None if similarity is None else float(similarity),
                json.dumps(rect) if rect is not None else None,
                json.dumps(notified, ensure_ascii=False) if notified else None,
            ),
        )
        eid = int(cur.lastrowid or 0)
        # 单实例命中事件只留最近 1000 条，避免无限增长
        c.execute(
            "DELETE FROM hit_events WHERE instance_id=? AND id NOT IN "
            "(SELECT id FROM hit_events WHERE instance_id=? ORDER BY id DESC LIMIT 1000)",
            (instance_id, instance_id),
        )
    return eid


def set_hit_notified(event_id: int, notified: dict[str, str]) -> None:
    """把逐通道的发送结果写回这一条事件。

    结果必须认准本次这条：写错行的话，事件列表里全是张冠李戴的通知状态。
    """
    with write() as c:
        c.execute(
            "UPDATE hit_events SET notified=? WHERE id=?",
            (json.dumps(notified, ensure_ascii=False), int(event_id)),
        )


def mark_hits_read(ids: "list[int] | None" = None) -> int:
    """标记已读，返回**本次真正被标记**的条数（已经读过的不重复算）。

    不传 ids = 全部标记（按钮就叫「全部标记已读」，是全局的）。
    条数要排除已读的，否则角标会翻倍。
    """
    ids = [int(i) for i in ids] if ids else None
    with write() as c:
        if ids:
            cur = c.execute(
                "UPDATE hit_events SET is_read=1 WHERE is_read=0 AND id IN (%s)" % ",".join("?" * len(ids)),
                tuple(ids),
            )
        else:
            cur = c.execute("UPDATE hit_events SET is_read=1 WHERE is_read=0")
        return int(cur.rowcount or 0)


def unread_count() -> int:
    """未读命中数（跨实例）。托盘角标用这个数。"""
    rows = query("SELECT COUNT(*) AS n FROM hit_events WHERE is_read=0")
    return int(rows[0]["n"]) if rows else 0


def list_hit_events(
    instance_id: "str | None" = None,
    tool: "str | None" = None,
    level: "str | None" = None,
    limit: int = 200,
    before_id: "int | None" = None,
    unread_only: bool = False,
) -> list[dict[str, Any]]:
    """跨实例检索命中事件（最新在前）。

    不带 instanceId 就是看全局 —— 这是这张表存在的理由：
    「这条差评规则一共命中过几次、在哪些实例上」要能一次问出来。
    `before_id` 是向后翻页的游标（取上一页最后一条的 id）。
    """
    where: list[str] = []
    args: list[Any] = []
    if instance_id is not None:
        where.append("instance_id=?")
        args.append(instance_id)
    if tool is not None:
        where.append("tool=?")
        args.append(tool)
    if level is not None:
        where.append("level=?")
        args.append(level)
    if before_id is not None:
        where.append("id<?")
        args.append(int(before_id))
    if unread_only:
        where.append("is_read=0")
    sql = f"SELECT {HIT_EVENT_FIELDS} FROM hit_events"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(int(limit))
    return [_hit_payload(r) for r in query(sql, tuple(args))]


def record_monitor_hit(
    instance_id: str, asset_id: str, similarity: float, rect: "list[int] | None" = None
) -> None:
    """记录一次桌面监控命中：图像命中、默认按「要提醒」处理。

    只是 `hit_events` 的一种写法 —— 命中事件只有一个写入点，别再开第二张表。
    """
    record_hit_event(
        instance_id=instance_id,
        tool="monitor",
        rule_id=asset_id,
        matched_by="image",
        level="alert",
        title=asset_id,
        similarity=similarity,
        rect=rect,
    )


def list_monitor_hits(instance_id: str, limit: int = 200) -> list[dict[str, Any]]:
    """按实例读取命中事件（最新在前）。

    字段保持运行详情页原来那四个（assetId / similarity / rect / ts），
    换底层表不该让界面跟着改。
    """
    return [
        {
            "assetId": e["ruleId"],
            "similarity": e["similarity"],
            "rect": e["rect"],
            "ts": e["ts"],
        }
        for e in list_hit_events(instance_id=instance_id, limit=limit)
    ]
