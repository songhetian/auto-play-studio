# -*- coding: utf-8 -*-
"""敏感词库的业务逻辑。

设计取舍：
- **词唯一**：同一个词只留一条。重复规则会让一次问题报两条命中，
  客服看到两条"退款政策"会以为是两次事件。
- **危级用三档**（high/mid/low）而不是"是否启用"：违禁词不是二元问题，
  "加微信"和"最"这种程度差别很大，一律弹窗等于把告警当噪音。
- **拼音键由系统按词自动算**：用户不必手填，也就不会填错；
  需要手输的场景（内部黑话）留 match_key 覆盖。
"""
from __future__ import annotations

import os
import uuid

from .. import db

MAX_WORD = 60
MAX_NOTE = 200

#: 允许的危级。存别的值会让 should_alert 的分级判断失效（未知级别不告警也不报警）
LEVELS = ("high", "mid", "low")

#: studio 词库的 severity 词汇（high/medium/low）映射到 app 的 level（high/mid/low）。
#: studio 用 medium、app 用 mid —— 不映射的话 "medium" 不是合法危级，整条被跳过，
#: 用户拿 studio 导出的 wordlib.json 来导入会"成功 0 条"。
SEVERITY_TO_LEVEL = {"high": "high", "medium": "mid", "low": "low"}

#: 拼音键允许的字符（ASCII 小写字母）。注意 `str.isalpha()` 对中文也为真，
#: 所以校验必须显式限定字母表，而不是靠 isalpha。
_ASCII_LETTERS = frozenset("abcdefghijklmnopqrstuvwxyz")


def _clean(value: str) -> str:
    return (value or "").strip()


def _validate(word: str, level: str, match_key: str) -> None:
    if not word:
        raise ValueError("违禁词不能为空")
    if len(word) > MAX_WORD:
        raise ValueError("违禁词太长了（最多 %d 字）" % MAX_WORD)
    if level not in LEVELS:
        raise ValueError("危级只能是 high / mid / low 之一")
    # 拼音键只用 ASCII 字母：混进中文会编译出永不匹配的正则，属于"配了但不生效"。
    # 注意 `str.isalpha()` 对中文也为真，必须显式限定 a-z。
    for ch in match_key.lower():
        if ch not in _ASCII_LETTERS:
            raise ValueError("拼音键只能填字母（如 tkzc 表示 退款政策）")


def _pinyin_initials(word: str) -> str:
    """中文取拼音首字母，非中文原样保留（英文缩写 vip → vip）。

    pypinyin 是可选依赖（requirements 里已有，但知识库之外也可能缺），
    缺了就退化成「只保留英文与数字」—— 拼音键没算出来不影响中文匹配。
    """
    letters = []
    try:
        from pypinyin import Style, lazy_pinyin

        for ch in word:
            if "一" <= ch <= "鿿":
                first = lazy_pinyin(ch, style=Style.FIRST_LETTER, errors="ignore")
                letters.append(first[0] if first else "")
            elif ch.isalnum():
                letters.append(ch.lower())
    except Exception:  # noqa: BLE001 —— 没装 pypinyin 只是少个拼音键，不该拦住建词
        letters = [ch.lower() for ch in word if ch.isalnum() and not ch.isspace()]
    return "".join(letters)


def _row_to_dict(row) -> dict:
    """字段名统一 camelCase，与前端 `SensitiveWord` 类型一致。"""
    return {
        "id": row["id"],
        "word": row["word"],
        "matchKey": row["match_key"],
        "level": row["level"],
        "caseSensitive": bool(row["case_sensitive"]),
        "enabled": bool(row["enabled"]),
        "note": row["note"],
        "hitCount": row["hit_count"],
    }


def _to_rule(row):
    """把 DB 行转成匹配引擎认识的规则对象。

    这是词库与 `sensitive.match_words` 之间唯一的接缝 —— 引擎不认 SQL 行，
    词库也不需要知道匹配算法长什么样。
    """
    from ..sensitive import WordRule

    return WordRule(
        word=row["word"],
        level=row["level"],
        match_key=row["match_key"],
        enabled=bool(row["enabled"]),
        case_sensitive=bool(row["case_sensitive"]),
    )


def list_words(q: str = "", level: str = "", enabled_only: bool = False) -> list[dict]:
    """列出词条。

    排序：**危级高的在前**（安全类工具最关心的永远是"最严重的在第一行"），
    同危级内按命中次数降序 —— 常用的、易触发的规则先看到。
    """
    sql = "SELECT * FROM sensitive_word WHERE 1=1"
    args: list = []
    if q:
        # ESCAPE 让 like_literal 转义过的 % / _ 变成字面量，而不是通配符
        sql += (
            " AND (word LIKE ? ESCAPE '\\' OR match_key LIKE ? ESCAPE '\\'"
            " OR note LIKE ? ESCAPE '\\')"
        )
        args += [db.like_literal(q)] * 3
    if level:
        sql += " AND level=?"
        args.append(level)
    if enabled_only:
        sql += " AND enabled=1"
    sql += " ORDER BY CASE level WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END, hit_count DESC, id DESC"
    return [_row_to_dict(r) for r in db.query(sql, tuple(args))]


def get_rules(only_enabled: bool = True) -> list:
    """取全部启用的规则供匹配引擎使用。"""
    sql = "SELECT * FROM sensitive_word WHERE enabled=1"
    return [_to_rule(r) for r in db.query(sql)]


def add_word(word: str, level: str = "mid", match_key: str = "",
             case_sensitive: bool = False, note: str = "") -> dict:
    word = _clean(word)
    match_key = _clean(match_key).lower()
    note = _clean(note)
    if len(note) > MAX_NOTE:
        raise ValueError("备注太长了（最多 %d 字）" % MAX_NOTE)
    _validate(word, level, match_key)

    # 拼音键没给就按词自动算：用户不该为了用这功能先去查每个字的拼音
    if not match_key:
        match_key = _pinyin_initials(word)

    # 同一个词不新增而是更新：库里已有这条时，用户想改的几乎总是**危级**。
    # 保留原有 id 与命中次数，否则重导一次词库就把"命中多少次"这个有用信息清零了。
    existing = db.query("SELECT id FROM sensitive_word WHERE word=?", (word,))
    if existing:
        return update_word(existing[0]["id"], {
            "level": level,
            "match_key": match_key,
            "case_sensitive": case_sensitive,
            "note": note,
        })

    with db.write() as c:
        cur = c.execute(
            "INSERT INTO sensitive_word(word, match_key, level, case_sensitive, enabled, note) "
            "VALUES (?,?,?,?,1,?)",
            (word, match_key, level, 1 if case_sensitive else 0, note),
        )
        wid = cur.lastrowid
    return _row_to_dict(db.query("SELECT * FROM sensitive_word WHERE id=?", (wid,))[0])


def update_word(wid: int, patch: dict) -> dict:
    row = db.query("SELECT * FROM sensitive_word WHERE id=?", (wid,))
    if not row:
        raise KeyError(wid)

    cur = row[0]
    word = _clean(patch.get("word") or cur["word"])
    level = patch.get("level") or cur["level"]
    match_key = patch.get("match_key")
    # 没显式传拼音键时：跟着新词重算（改了词还留着旧词的拼音键 = 静默失配）
    match_key = _clean(match_key).lower() if match_key is not None else _pinyin_initials(word)
    case_sensitive = patch.get("case_sensitive")
    case_sensitive = cur["case_sensitive"] if case_sensitive is None else bool(case_sensitive)
    note = patch.get("note")
    note = cur["note"] if note is None else _clean(note)
    _validate(word, level, match_key)

    with db.write() as c:
        c.execute(
            "UPDATE sensitive_word SET word=?, match_key=?, level=?, case_sensitive=?, note=?, "
            "updated_at=datetime('now','localtime') WHERE id=?",
            (word, match_key, level, 1 if case_sensitive else 0, note, wid),
        )
    return _row_to_dict(db.query("SELECT * FROM sensitive_word WHERE id=?", (wid,))[0])


def set_enabled(wid: int, enabled: bool) -> dict:
    """启用/停用。停用是"临时不生效"而不是删除 —— 词库通常一次配好长期用。"""
    if not db.query("SELECT id FROM sensitive_word WHERE id=?", (wid,)):
        raise KeyError(wid)
    with db.write() as c:
        c.execute(
            "UPDATE sensitive_word SET enabled=?, updated_at=datetime('now','localtime') WHERE id=?",
            (1 if enabled else 0, wid),
        )
    return _row_to_dict(db.query("SELECT * FROM sensitive_word WHERE id=?", (wid,))[0])


def delete_word(wid: int) -> None:
    if not db.query("SELECT id FROM sensitive_word WHERE id=?", (wid,)):
        raise KeyError(wid)
    with db.write() as c:
        c.execute("DELETE FROM sensitive_word WHERE id=?", (wid,))


def import_words(text: str) -> dict:
    """从纯文本批量导入：一行一个词，可用逗号/顿号分隔危级。

    返回逐条结果而不是一个总数 —— 批量导入一定有格式不对的行，
    只给「成功 30 条」用户不知道哪几条没进去。
    """
    added: list[str] = []
    skipped: list[dict] = []

    for lineno, raw in enumerate((text or "").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # 支持「退款政策,high」「退款政策 high」两种写法
        parts = [p for p in line.replace("，", ",").replace("、", ",").replace(" ", ",").split(",") if p]
        word = parts[0]
        level = parts[1] if len(parts) > 1 else "mid"
        try:
            add_word(word, level)
            added.append(word)
        except Exception as exc:  # noqa: BLE001 —— 一行失败不该中断整批
            skipped.append({"line": lineno, "word": word, "reason": str(exc)})

    return {"added": added, "skipped": skipped}


def bump_hit(wid: int, times: int = 1) -> None:
    """命中计数 +1：用于排序与"这条规则一直没生效"的判断。"""
    with db.write() as c:
        c.execute("UPDATE sensitive_word SET hit_count = hit_count + ? WHERE id=?", (times, wid))


def _current_seat() -> str:
    """坐席 = 本机 Windows 用户（纯单机 A 线，一人一机）。

    取不到（非 Windows / 沙箱）时退空串，统计页按「本机用户」这一轴仍能工作，
    只是坐席列显示为空 —— 不能因为拿不到用户名就拦住违规记录。
    """
    try:
        return os.getlogin()
    except Exception:  # noqa: BLE001 —— 设备层不可用时降级
        return ""


def record_violations(hits: "list", instance_id: str = "", seat: str = "", text: str = "") -> None:
    """把一轮命中逐条落违规事件（与 ``bump_hit`` 计数互补）。

    - 危级从 ``MatchHit.level`` 带过来，统计页才能按危级聚合；
    - ``text`` 取命中上下文前 200 字存进 ``detail``，抽检时能回看当时打了什么；
    - 记录失败只记日志不抛：违规落库是附加价值，绝不能反过来卡住告警主链路。
    """
    seat = seat or _current_seat()
    detail = (text or "")[:200]
    for h in hits:
        try:
            db.record_violation(
                word=h.word,
                level=h.level,
                seat=seat,
                instance_id=instance_id,
                detail=detail,
            )
        except Exception:  # noqa: BLE001
            pass


def import_json(payload) -> dict:
    """从 JSON 导入词库，**兼容两种常见结构**。

    现实里导出的词库格式很杂：有人导出的是 ``["加微信", "私下交易"]``，
    有人导出的是 ``[{"word": "退款政策", "level": "mid"}]``（带危级/备注）。
    只认一种的话，用户导入时第一反应是"导入失败"，而且他不知道自己该改成哪种 ——
    所以两种都收，缺字段走默认值。

    返回逐条结果（同 ``import_words``）：批量一定有格式不对的行，
    只给「成功 N 条」用户不知道哪几条没进去。
    """
    added: list[str] = []
    skipped: list[dict] = []

    # 顶层既可以直接是数组，也可以是 {"words": [...]}（导出工具常见包装）
    items = payload.get("words") if isinstance(payload, dict) else payload
    if items is None:
        items = payload if isinstance(payload, list) else []
    if not isinstance(items, list):
        raise ValueError("JSON 顶层应当是数组，或包含 words 数组的对象")

    for idx, item in enumerate(items, 1):
        # 形态归一：字符串 / 带字段的对象 / 已经是内部字段名
        if isinstance(item, str):
            word, level, match_key, note, case_sensitive = item, "mid", "", "", False
            enabled = True
            # 字符串项也支持 "退款政策,high" 这种带危级的写法 —— 与纯文本导入保持一致，
            # 否则用户从纯文本切到 JSON 后同样的内容反而进不去（且危级被当成词的一部分）
            if "," in word or "，" in word:
                parts = [x for x in word.replace("，", ",").replace("、", ",").split(",") if x.strip()]
                word = parts[0].strip()
                if len(parts) > 1:
                    level = parts[1].strip()
        elif isinstance(item, dict):
            word = str(item.get("word") or item.get("text") or "").strip()
            # studio 用 severity（high/medium/low），app 用 level（high/mid/low）；
            # 两者都要认，medium→mid 必须映射，否则 "medium" 不是合法危级会被整条跳过
            raw_level = str(item.get("level") or item.get("severity") or "mid").strip().lower()
            level = SEVERITY_TO_LEVEL.get(raw_level, raw_level)
            # 内部命名用 match_key，外面可能给 matchKey / pinyin
            match_key = str(item.get("match_key") or item.get("matchKey") or item.get("pinyin") or "")
            note = str(item.get("note") or item.get("remark") or "")
            case_sensitive = bool(item.get("case_sensitive") or item.get("caseSensitive"))
            # studio 的 WordEntry 有 enabled 字段，app 默认启用，需显式尊重停用
            enabled = item.get("enabled", True)
            if isinstance(enabled, str):
                enabled = enabled.strip().lower() in ("1", "true", "yes", "y", "t")
            else:
                enabled = bool(enabled)
        else:
            skipped.append({"line": idx, "word": str(item)[:20], "reason": "格式无法识别（应是字符串或对象）"})
            continue

        try:
            entry = add_word(word, level, match_key, case_sensitive, note)
            # 源文件标记为停用 → 入库后也停用，否则与源不一致（app 默认启用）
            if not enabled:
                set_enabled(entry["id"], False)
            added.append(word)
        except Exception as exc:  # noqa: BLE001 —— 一条失败不该中断整批
            skipped.append({"line": idx, "word": word or "(空)", "reason": str(exc)})

    return {"added": added, "skipped": skipped}


def stats() -> dict:
    rows = db.query("SELECT level, enabled, COUNT(*) AS n FROM sensitive_word GROUP BY level, enabled")
    out = {"total": 0, "enabled": 0, "high": 0, "mid": 0, "low": 0, "disabled": 0}
    for r in rows:
        n = r["n"]
        out["total"] += n
        out[r["level"]] = out.get(r["level"], 0) + n
        if r["enabled"]:
            out["enabled"] += n
        else:
            out["disabled"] += n
    return out


#: app 的 level（high/mid/low）映射回 studio 的 severity（high/medium/low）
LEVEL_TO_SEVERITY = {"high": "high", "mid": "medium", "low": "low"}


def export_json() -> dict:
    """导出成 studio 的 wordlib.json 格式，便于在 Studio 里编辑后再分发给客户端。

    - id 用 word 派生出的**稳定 Guid**（uuid5），保证 studio 能反序列化且回灌时按 id 去重；
      不能裸用自增主键，否则 studio 的 ``Guid`` 反序列化直接失败、整个词库退化成空。
    - severity 从 level 映射回 studio 词汇；category/matchMode 用 studio 默认值
      （app 当前不存这两项，导出时给空 / 模糊包含即可，studio 导入后照常工作）。
    """
    from datetime import datetime, timezone

    rows = list_words()
    words = []
    for w in rows:
        words.append({
            "id": str(uuid.uuid5(uuid.NAMESPACE_DNS, "word:" + w["word"])),
            "text": w["word"],
            "matchKey": w["matchKey"] or "",
            "category": "",
            "severity": LEVEL_TO_SEVERITY.get(w["level"], "medium"),
            "matchMode": "fuzzyContains",
            "enabled": bool(w["enabled"]),
        })
    return {
        "schemaVersion": 1,
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "words": words,
        "categories": [],
    }