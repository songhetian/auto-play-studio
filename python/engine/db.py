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
    snapshot    TEXT NOT NULL DEFAULT '',      -- 命中瞬间的截图（相对素材库根目录），空串=没存成
    notified    TEXT,                           -- JSON：逐通道发送结果 {"desktop":"ok"}
    is_read     INTEGER NOT NULL DEFAULT 0,     -- 已读标记（托盘角标 / 事件列表页）
    -- 处置状态：pending=待人工确认（默认）/ acknowledged=已确认（闭环了）。
    -- 「未确认超时」不落库：它是 pending 且超过时限**推算**出来的看板状态，
    -- 落库要靠定时任务扫，而这条信息随时钟走，存下来只会过期。
    disposition TEXT NOT NULL DEFAULT 'pending',
    ack_at      TEXT,                           -- 确认时刻（localtime），NULL = 从没确认过
    ts          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_hit_events_instance ON hit_events(instance_id, id);
CREATE INDEX IF NOT EXISTS idx_hit_events_level ON hit_events(level, id);

-- 方案（plans）：可复用的配置模板，见 engine/plans.py。
-- 它跟实例没有引用关系：方案是「配置模板层」，实例是「运行主体层」，
-- 删实例方案还在，改实例方案不变 —— 唯一联系人是「新建实例时套一份过来」。
-- （以前方案只是 cmp 的一个按钮，存在 uploads/<iid>/ 下，删实例就没了。）
CREATE TABLE IF NOT EXISTS plans (
    id          TEXT PRIMARY KEY,
    tool        TEXT NOT NULL,
    name        TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_plans_tool ON plans(tool);

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

-- 段落向量（语义检索用）：一行 = 一个段落的向量。
-- vec 是 **L2 归一化后**的 float32 小端字节（见 engine/kb/semantic.py）——
-- 归一化放在写入时，检索时余弦就退化成点积，省掉每次查询的 N 次开方。
-- model 记模型名：换了模型，向量所在的空间就变了，旧向量必须整体重算；
-- 混着用不会报错，只会让排序悄悄变差，所以读的时候按 model 过滤。
CREATE TABLE IF NOT EXISTS kb_embed (
    doc_id INTEGER NOT NULL,
    idx    INTEGER NOT NULL,
    dim    INTEGER NOT NULL,
    model  TEXT NOT NULL DEFAULT '',
    vec    BLOB NOT NULL,
    PRIMARY KEY (doc_id, idx)
);

CREATE TABLE IF NOT EXISTS kb_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    query        TEXT NOT NULL UNIQUE,
    result_count INTEGER NOT NULL DEFAULT 0,
    used_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 话术库：客服常用回复模板，按分类收纳，支持 {变量} 占位符
CREATE TABLE IF NOT EXISTS phrase (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    title     TEXT NOT NULL,
    body      TEXT NOT NULL,
    category  TEXT NOT NULL DEFAULT '',
    -- 使用次数：常用的排前面，省得在一堆话术里翻
    used_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 同一标题只留一条：用户改话术是"覆盖"，不是"越积越多"
CREATE UNIQUE INDEX IF NOT EXISTS idx_phrase_title ON phrase(title);

-- 敏感词库（见 engine/sensitive_words/）：违禁词规则，是「敏感词监控」工具的数据源。
-- 与 image_assets 分开：那是图片模板，这是文本规则，两者的匹配逻辑完全不同
-- （图片走 OpenCV 模板匹配，敏感词走子串 + 拼音首字母）。
CREATE TABLE IF NOT EXISTS sensitive_word (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    word       TEXT NOT NULL,
    -- 拼音首字母键（tkzc → 退款政策）：客服只记得缩写时也能命中
    match_key  TEXT NOT NULL DEFAULT '',
    -- 危级 high / mid / low：决定命中的告警强度与弹窗措辞
    level      TEXT NOT NULL DEFAULT 'mid',
    -- 英文缩写要不要区分大小写（vip 与 VIP 是不是同一个词）
    case_sensitive INTEGER NOT NULL DEFAULT 0,
    enabled    INTEGER NOT NULL DEFAULT 1,
    note       TEXT NOT NULL DEFAULT '',
    -- 命中次数：常用的词排前面，也方便发现"这条规则一直没生效"
    hit_count  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 同一个词只留一条：重复规则会让同一个问题报两次
CREATE UNIQUE INDEX IF NOT EXISTS idx_sensitive_word ON sensitive_word(word);

-- 违规事件：敏感词命中落库（主管事后抽检 / 统计用，工单 04 · ④）。
-- 与 sensitive_word.hit_count 计数器是两回事：计数器只 +1（用于排序「这条规则生效频率」），
-- 这里存「谁在什么时候、因为哪个词、什么危级违规了」的完整事件，能按词/危级/时间聚合与导出。
-- seat 在纯单机（A 线）下恒为本机 Windows 用户（os.getlogin()），预留跨机汇总时再扩展。
CREATE TABLE IF NOT EXISTS violation_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    word        TEXT NOT NULL,
    level       TEXT NOT NULL DEFAULT 'mid',   -- high / mid / low，决定违规严重程度
    seat        TEXT NOT NULL DEFAULT '',        -- 本机用户；A 线即坐席
    instance_id TEXT NOT NULL DEFAULT '',        -- 命中的 guard 实例（定位用）
    tool        TEXT NOT NULL DEFAULT 'guard',
    detail      TEXT NOT NULL DEFAULT '',        -- 命中上下文（前 200 字）
    ts          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_violation_word ON violation_events(word, id);
CREATE INDEX IF NOT EXISTS idx_violation_ts ON violation_events(ts, id);
CREATE INDEX IF NOT EXISTS idx_violation_seat ON violation_events(seat, id);
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


#: 库结构版本：每次改 SCHEMA、或往 _MIGRATIONS 加一级，都要 +1。
SCHEMA_VERSION = 5

#: 版本号 → 升到该版本要补的语句。
#: 新库由 SCHEMA 一次建到最新，这些只在老库上跑（见 ADR-0001 的迁移约定）。
_MIGRATIONS: dict[int, tuple[str, ...]] = {
    2: ("ALTER TABLE hit_events ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0",),
    # 命中瞬间的画面快照（相对素材库根目录的路径，空串 = 没存成）。
    # 存路径不存图片本身：命中是高频事件，base64 进库会让 db 迅速膨胀。
    3: ("ALTER TABLE hit_events ADD COLUMN snapshot TEXT NOT NULL DEFAULT ''",),
    # 告警确认闭环：处置状态 + 确认时刻。
    4: (
        "ALTER TABLE hit_events ADD COLUMN disposition TEXT NOT NULL DEFAULT 'pending'",
        "ALTER TABLE hit_events ADD COLUMN ack_at TEXT",
    ),
    # 违规事件表（主管抽检 / 统计）。建表 + 索引；老库上补，新库走 SCHEMA。
    5: (
        "CREATE TABLE IF NOT EXISTS violation_events ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  word TEXT NOT NULL,"
        "  level TEXT NOT NULL DEFAULT 'mid',"
        "  seat TEXT NOT NULL DEFAULT '',"
        "  instance_id TEXT NOT NULL DEFAULT '',"
        "  tool TEXT NOT NULL DEFAULT 'guard',"
        "  detail TEXT NOT NULL DEFAULT '',"
        "  ts TEXT NOT NULL DEFAULT (datetime('now','localtime'))"
        ")",
        "CREATE INDEX IF NOT EXISTS idx_violation_word ON violation_events(word, id)",
        "CREATE INDEX IF NOT EXISTS idx_violation_ts ON violation_events(ts, id)",
        "CREATE INDEX IF NOT EXISTS idx_violation_seat ON violation_events(seat, id)",
    ),
}


def _is_new_database(c: sqlite3.Connection) -> bool:
    """`instances` 是最早建的表：它不存在，就说明这是全新库。"""
    row = c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='instances'").fetchone()
    return row is None


def _migrate(c: sqlite3.Connection) -> None:
    """按 `PRAGMA user_version` 把老库逐级升到 SCHEMA_VERSION。

    ADR-0001 约定迁移用 user_version 记账，不引重量级框架。但**失败不再一律吞掉**：
    只有「列已经存在」（老库被手工补过列）才放过，其余照常抛 —— 否则
    「迁移真的失败了」和「早就迁过了」根本分不出来。
    """
    current = c.execute("PRAGMA user_version").fetchone()[0]
    for version in sorted(_MIGRATIONS):
        if version <= current:
            continue
        for stmt in _MIGRATIONS[version]:
            try:
                c.execute(stmt)
            except sqlite3.OperationalError as exc:
                if "duplicate column name" not in str(exc):
                    raise
        c.execute(f"PRAGMA user_version = {version}")


# 导入时先建表（用一条临时连接，之后各线程自建连接）
_bootstrap = _connect()
_fresh = _is_new_database(_bootstrap)
_bootstrap.executescript(SCHEMA)
if _fresh:
    # 新库：SCHEMA 已经是最新结构，直接记到当前版本，不必再跑一遍迁移
    _bootstrap.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
else:
    _migrate(_bootstrap)
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


def like_literal(value: str) -> str:
    """把用户输入包成 LIKE 的「包含」模式，并转义 `%` / `_` 通配符。

    `%` / `_` 是 LIKE 的元字符：搜「100%」会被当成「包含 100」、搜「a_b」
    会匹配「aXb」，返回一堆无关结果。调用方 SQL 必须写成 `LIKE ? ESCAPE '\\'`。
    """
    escaped = (value or "").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return "%%%s%%" % escaped


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


#: settings 表里存「词库文件监听路径」的 key
WORDLIB_WATCH_KEY = "wordlib_watch"


def get_wordlib_path() -> str:
    """被监听的 wordlib.json 路径；没配过返回空串。"""
    rows = query("SELECT value_json FROM settings WHERE key=?", (WORDLIB_WATCH_KEY,))
    if not rows:
        return ""
    try:
        return str(json.loads(rows[0]["value_json"]).get("path") or "")
    except (ValueError, AttributeError, TypeError):
        return ""


def save_wordlib_path(path: str) -> str:
    """保存被监听的路径（空串 = 关闭自动同步）。"""
    path = (path or "").strip()
    with write() as c:
        c.execute(
            "INSERT INTO settings(key, value_json, updated_at) VALUES (?,?,datetime('now','localtime')) "
            "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
            (WORDLIB_WATCH_KEY, json.dumps({"path": path}, ensure_ascii=False)),
        )
    return path


#: settings 表里存「每日汇总」配置的 key
DAILY_SUMMARY_KEY = "daily_summary"
#: settings 表里存「待补发的汇总日期」的 key
DAILY_SUMMARY_PENDING_KEY = "daily_summary_pending"

DEFAULT_DAILY_SUMMARY_CONFIG = {
    "enabled": False,
    "send_time": "18:00",
    "last_sent_date": "",
}


def _merged_daily_summary_config(saved: dict[str, Any]) -> dict[str, Any]:
    cfg: dict[str, Any] = dict(DEFAULT_DAILY_SUMMARY_CONFIG)
    if isinstance(saved, dict):
        if isinstance(saved.get("enabled"), bool):
            cfg["enabled"] = saved["enabled"]
        if isinstance(saved.get("send_time"), str) and saved["send_time"]:
            cfg["send_time"] = saved["send_time"]
        if isinstance(saved.get("last_sent_date"), str):
            cfg["last_sent_date"] = saved["last_sent_date"]
    return cfg


def get_daily_summary_config() -> dict[str, Any]:
    """读取每日汇总配置（没配过就给默认值）。"""
    rows = query("SELECT value_json FROM settings WHERE key=?", (DAILY_SUMMARY_KEY,))
    saved = json.loads(rows[0]["value_json"]) if rows else {}
    return _merged_daily_summary_config(saved)


def save_daily_summary_config(patch: dict[str, Any]) -> dict[str, Any]:
    """合入配置块（enabled / send_time / last_sent_date），返回合并后的完整配置。"""
    merged = _merged_daily_summary_config({**get_daily_summary_config(), **(patch or {})})
    with write() as c:
        c.execute(
            "INSERT INTO settings(key, value_json, updated_at) VALUES (?,?,datetime('now','localtime')) "
            "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
            (DAILY_SUMMARY_KEY, json.dumps(merged, ensure_ascii=False)),
        )
    return merged


def get_pending_summary_dates() -> list[str]:
    """待补发的汇总日期（之前 webhook 没发出去的）。"""
    rows = query("SELECT value_json FROM settings WHERE key=?", (DAILY_SUMMARY_PENDING_KEY,))
    if not rows:
        return []
    try:
        data = json.loads(rows[0]["value_json"])
        return [str(d) for d in data.get("dates", [])] if isinstance(data, dict) else []
    except (ValueError, AttributeError, TypeError):
        return []


def set_pending_summary_dates(dates: "list[str]") -> None:
    """覆盖待补发日期列表（发出去的就移除）。"""
    with write() as c:
        c.execute(
            "INSERT INTO settings(key, value_json, updated_at) VALUES (?,?,datetime('now','localtime')) "
            "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
            (DAILY_SUMMARY_PENDING_KEY, json.dumps({"dates": list(dates)}, ensure_ascii=False)),
        )


#: 处置状态只有两档：还没人管 / 已经闭环。
#: （「未确认超时」是看板按时间推的第三种显示态，不进这两档，因为它会随钟走。）
DISPOSITION_PENDING = "pending"
DISPOSITION_ACKNOWLEDGED = "acknowledged"

HIT_EVENT_FIELDS = (
    "id, instance_id, tool, rule_id, matched_by, level, title, detail, similarity, rect, snapshot, "
    "notified, is_read, disposition, ack_at, ts"
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
        "snapshot": r["snapshot"] or "",
        "notified": json.loads(r["notified"]) if r["notified"] else {},
        "read": bool(r["is_read"]),
        # 处置状态：pending / acknowledged。「未确认超时」由前端按 ts 推算，
        # 这里只交代「库里的客观事实」——是否已被人确认过。
        "disposition": r["disposition"] or "pending",
        "ackAt": r["ack_at"] or "",
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
    snapshot: str = "",
) -> int:
    """记一次命中事件，返回事件 id。

    `notified` 由调用方把分发结果（逐通道 ok/fail）回写进来，
    这样事件列表能回答「这条到底通知出去没有」。

    `snapshot` 是命中瞬间的截图路径（相对素材库根目录）。存图失败传空串即可，
    命中照记 —— 存图是附加能力，不能反过来卡住主链路。
    """
    with write() as c:
        cur = c.execute(
            "INSERT INTO hit_events(instance_id, tool, rule_id, matched_by, level, title, detail, "
            "similarity, rect, notified, snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
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
                snapshot or "",
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


def ack_hit_events(ids: "list[int] | None" = None) -> int:
    """确认命中事件（闭环），返回**本次真正被确认**的条数。

    不传 ids = 全部确认（跨实例，与「全部标记已读」同一脾气）。
    已确认的不再重复计数，否则「确认了多少条」这种统计会越点越虚。

    顺带标记已读：确认意味着「处理了」，处理过的一定看过了 ——
    再让已确认的挂在未读角标上，用户会以为还有事没看完。
    """
    ids = [int(i) for i in ids] if ids else None
    with write() as c:
        if ids:
            cur = c.execute(
                "UPDATE hit_events SET disposition=?, ack_at=datetime('now','localtime'), is_read=1 "
                "WHERE disposition!=? AND id IN (%s)" % ",".join("?" * len(ids)),
                (DISPOSITION_ACKNOWLEDGED, DISPOSITION_ACKNOWLEDGED, *ids),
            )
        else:
            cur = c.execute(
                "UPDATE hit_events SET disposition=?, ack_at=datetime('now','localtime'), is_read=1 "
                "WHERE disposition!=?",
                (DISPOSITION_ACKNOWLEDGED, DISPOSITION_ACKNOWLEDGED),
            )
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


#: 违规事件字段（与 hits 分开：违规是可聚合的「谁因为哪个词违规了」记录）
VIOLATION_FIELDS = "id, word, level, seat, instance_id, tool, detail, ts"


def record_violation(
    word: str,
    level: str = "mid",
    seat: str = "",
    instance_id: str = "",
    tool: str = "guard",
    detail: str = "",
) -> int:
    """记一次敏感词违规事件，返回事件 id。

    与 ``hit_count`` 计数器互补：计数器只 +1（用于排序「这条规则生效频率」），
    这里存完整事件，让主管能事后按词 / 危级 / 时间聚合、导出、抽检。
    """
    with write() as c:
        cur = c.execute(
            "INSERT INTO violation_events(word, level, seat, instance_id, tool, detail) "
            "VALUES (?,?,?,?,?,?)",
            (word, level, seat or "", instance_id or "", tool or "guard", detail or ""),
        )
        return int(cur.lastrowid or 0)


def _violation_payload(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": r["id"],
        "word": r["word"],
        "level": r["level"],
        "seat": r["seat"] or "",
        "instanceId": r["instance_id"] or "",
        "tool": r["tool"] or "guard",
        "detail": r["detail"] or "",
        "ts": r["ts"],
    }


def list_violations(
    word: "str | None" = None,
    level: "str | None" = None,
    seat: "str | None" = None,
    date_from: "str | None" = None,
    date_to: "str | None" = None,
    limit: int = 500,
    before_id: "int | None" = None,
) -> list[dict[str, Any]]:
    """检索违规事件（最新在前）。

    筛选轴对齐主管抽检：按词、按危级、按坐席、按时间区间。
    ``date_from`` / ``date_to`` 用 ``date(ts)`` 比较，传 ``YYYY-MM-DD`` 即可。
    """
    where: list[str] = []
    args: list[Any] = []
    if word is not None:
        where.append("word=?")
        args.append(word)
    if level is not None:
        where.append("level=?")
        args.append(level)
    if seat is not None:
        where.append("seat=?")
        args.append(seat)
    if date_from is not None:
        where.append("date(ts) >= date(?)")
        args.append(date_from)
    if date_to is not None:
        where.append("date(ts) <= date(?)")
        args.append(date_to)
    if before_id is not None:
        where.append("id<?")
        args.append(int(before_id))
    sql = f"SELECT {VIOLATION_FIELDS} FROM violation_events"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(int(limit))
    return [_violation_payload(r) for r in query(sql, tuple(args))]


def summarize_violations(filters: "dict[str, Any] | None" = None) -> dict[str, Any]:
    """聚合违规事件，供统计页消费。

    返回总数、按词计数（带上该词的最高危级）、按危级计数。
    时间 / 词 / 危级 / 坐席 筛选同样生效，统计页的筛选条件直接透传。
    """
    filters = filters or {}
    where: list[str] = []
    args: list[Any] = []
    if filters.get("word"):
        where.append("word=?")
        args.append(filters["word"])
    if filters.get("level"):
        where.append("level=?")
        args.append(filters["level"])
    if filters.get("seat"):
        where.append("seat=?")
        args.append(filters["seat"])
    if filters.get("date_from"):
        where.append("date(ts) >= date(?)")
        args.append(filters["date_from"])
    if filters.get("date_to"):
        where.append("date(ts) <= date(?)")
        args.append(filters["date_to"])
    clause = (" WHERE " + " AND ".join(where)) if where else ""

    total = query(f"SELECT COUNT(*) AS n FROM violation_events{clause}", tuple(args))[0]["n"]

    # 按词计数，level 取该词命中的最高危级（high>mid>low），便于统计页按色块标危级
    by_word: list[dict] = []
    for r in query(
        "SELECT word,"
        " CASE MAX(CASE level WHEN 'high' THEN 3 WHEN 'mid' THEN 2 ELSE 1 END)"
        "  WHEN 3 THEN 'high' WHEN 2 THEN 'mid' ELSE 'low' END AS level,"
        " COUNT(*) AS c"
        f" FROM violation_events{clause} GROUP BY word ORDER BY c DESC, word",
        tuple(args),
    ):
        by_word.append({"word": r["word"], "level": r["level"], "count": int(r["c"])})

    by_level_rows = query(
        f"SELECT level, COUNT(*) AS c FROM violation_events{clause} GROUP BY level", tuple(args)
    )
    by_level = {row["level"]: int(row["c"]) for row in by_level_rows}

    return {"total": int(total), "byWord": by_word, "byLevel": by_level}


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
