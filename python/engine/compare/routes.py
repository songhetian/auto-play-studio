"""Excel 对比的 HTTP 路由（挂在 /api/compare 与 /api/instances/{iid}/compare 下）。

路由只做参数校验与落库，业务逻辑全在 service / compare_core 里。
"""
from __future__ import annotations

import json
import os
import tempfile

from fastapi import APIRouter, File, HTTPException, UploadFile

from . import config_io, service

router = APIRouter()

UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "autoplay", "compare")

ALLOWED_SUFFIX = {".xlsx", ".xlsm"}


def _save(iid: str, file: UploadFile) -> str:
    suffix = os.path.splitext(file.filename or "")[1].lower()
    if suffix not in ALLOWED_SUFFIX:
        raise HTTPException(400, f"仅支持 .xlsx / .xlsm（旧版 .xls 请先另存为 .xlsx），收到：{suffix or '无扩展名'}")
    dst_dir = os.path.join(UPLOAD_DIR, iid)
    os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, os.path.basename(file.filename or "table.xlsx"))
    with open(dst, "wb") as f:
        f.write(file.file.read())
    return dst


def cfg_of(iid: str) -> dict:
    from .. import db

    cfg = db.get_config(iid)
    if cfg.get("tool") != "cmp":
        raise HTTPException(400, "该实例不是 Excel 对比工具")
    return cfg


@router.post("/instances/{iid}/compare/upload")
async def upload(iid: str, role: str, file: UploadFile = File(...)):
    """上传 A 表（role=primary）或对比表（role=other）。"""
    if role not in ("primary", "other"):
        raise HTTPException(400, "role 只能是 primary 或 other")
    from .. import db

    path = _save(iid, file)
    try:
        table = service.load_table(path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, str(exc))

    cfg = cfg_of(iid)
    cmp_cfg = cfg.setdefault("cmp", {})
    if role == "primary":
        cmp_cfg["primaryFile"] = path
        cmp_cfg["primaryColumns"] = table["columns"]
        # 换了主表就重建字段列表，角色默认全部为「对比」，由用户指定主键
        cmp_cfg["primaryFields"] = [{"name": c, "role": "compare", "type": "text"} for c in table["columns"]]
        cmp_cfg["maps"] = {}
    else:
        files = cmp_cfg.setdefault("otherFiles", [])
        if path not in files:
            files.append(path)
        cmp_cfg.setdefault("tables", {})[table["name"]] = {"path": path, "columns": table["columns"]}
    db.save_config(iid, cfg)
    db.log(iid, f"已读取 {table['name']} · {len(table['columns'])} 列 / {len(table['data'])} 行")

    return {"name": table["name"], "path": path, "columns": table["columns"], "rows": len(table["data"])}


@router.delete("/instances/{iid}/compare/table")
def remove_table(iid: str, name: str):
    """从对比表中移除一张（只从配置里摘掉，不删磁盘文件）。"""
    from .. import db

    cfg = cfg_of(iid)
    cmp_cfg = cfg.setdefault("cmp", {})
    info = cmp_cfg.get("tables", {}).pop(name, None)
    if info:
        cmp_cfg["otherFiles"] = [p for p in cmp_cfg.get("otherFiles", []) if p != info.get("path")]
        cmp_cfg.get("maps", {}).pop(name, None)
        db.save_config(iid, cfg)
    return {"ok": True}


@router.post("/instances/{iid}/compare/auto-map")
def automap(iid: str, table_name: str | None = None, force: bool = True):
    """给指定对比表（不给则全部）自动匹配列映射。"""
    from .. import db

    cfg = cfg_of(iid)
    cmp_cfg = cfg.setdefault("cmp", {})
    if not cmp_cfg.get("primaryFile"):
        raise HTTPException(400, "请先上传 A 表（主表）")
    fields = cmp_cfg.get("primaryFields", [])
    if not fields:
        raise HTTPException(400, "A 表还没有字段")

    tables = cmp_cfg.get("tables", {})
    targets = [table_name] if table_name else list(tables)
    maps = cmp_cfg.setdefault("maps", {})
    for name in targets:
        info = tables.get(name)
        if not info:
            continue
        table = service.load_table(info["path"])
        maps[name] = service.auto_maps(fields, table, existing=maps.get(name), force=force)
    db.save_config(iid, cfg)
    return {"maps": maps}


@router.post("/instances/{iid}/compare/run")
def run(iid: str):
    """立即执行一次对比，结果落库并写出报告文件。"""
    from .. import db
    from ..runner import get_runner

    cfg = cfg_of(iid)
    cmp_cfg = cfg["cmp"]
    if not cmp_cfg.get("primaryFile"):
        raise HTTPException(400, "请先上传 A 表（主表）")

    report = _execute(cmp_cfg)

    out = _report_path(iid)
    service.write(out, report, os.path.basename(cmp_cfg["primaryFile"]), cmp_cfg.get("tolerance", 0.0))
    save_report_json(iid, report)
    cmp_cfg["outFile"] = out
    db.save_config(iid, cfg)

    run_id = _persist(iid, report)
    db.log(iid, f"对比完成：{json.dumps(report['summary'], ensure_ascii=False)} → {out}")
    return {"report": report, "outFile": out, "runId": run_id}


def _report_path(iid: str) -> str:
    d = os.path.join(UPLOAD_DIR, iid)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "对比报告.xlsx")


def report_json_path(iid: str) -> str:
    d = os.path.join(UPLOAD_DIR, iid)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "对比结果.json")


def save_report_json(iid: str, report: dict) -> str:
    """把报告 JSON 落盘：前端刷新页面后还能把上次的对比结果画出来。"""
    path = report_json_path(iid)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False)
    return path


def load_report_json(iid: str) -> dict | None:
    path = report_json_path(iid)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _execute(cmp_cfg: dict) -> dict:
    primary = service.load_table(cmp_cfg["primaryFile"])
    fields = cmp_cfg.get("primaryFields", [])
    maps = cmp_cfg.get("maps", {})
    others = []
    for name, info in cmp_cfg.get("tables", {}).items():
        table = service.load_table(info["path"])
        others.append({"table": table, "maps": maps.get(name, {})})
    return service.run(primary, fields, others, cmp_cfg.get("tolerance", 0.0))


def _persist(iid: str, report: dict) -> int:
    from .. import db

    with db.write() as c:
        c.execute("UPDATE instances SET progress_total=? WHERE id=?", (len(report["rows"]), iid))
        c.execute("INSERT INTO runs(instance_id, status) VALUES (?, 'completed')", (iid,))
        run_id = c.execute("SELECT last_insert_rowid()").fetchone()[0]
        for r in service.rows_for_db(report):
            c.execute(
                "INSERT INTO rows(run_id, row_no, key_value, status, message, duration_ms) VALUES (?,?,?,?,?,?)",
                (run_id, r["row_no"], r["key_value"], r["status"], r["message"], 0),
            )
        c.execute("UPDATE instances SET progress_done=? WHERE id=?", (len(report["rows"]), iid))
    return run_id


@router.get("/instances/{iid}/compare/result")
def last_result(iid: str):
    """取上一次对比结果（刷新页面后仍可展示）。"""
    cfg_of(iid)
    report = load_report_json(iid)
    if report is None:
        raise HTTPException(404, "还没有对比结果")
    return report


@router.get("/instances/{iid}/compare/report")
def download_path(iid: str):
    from .. import db

    cfg = cfg_of(iid)
    out = cfg.get("cmp", {}).get("outFile")
    if not out or not os.path.exists(out):
        raise HTTPException(404, "还没有生成报告，请先执行一次对比")
    return {"path": out}


@router.post("/instances/{iid}/compare/plan")
def save_plan(iid: str):
    """把当前方案存成 json，下次同结构文件可一键复用。"""
    from .. import db

    cfg = cfg_of(iid)
    cmp_cfg = cfg["cmp"]
    if not cmp_cfg.get("primaryFile"):
        raise HTTPException(400, "请先上传 A 表（主表）")

    primary = service.load_table(cmp_cfg["primaryFile"])
    others = [
        {"table": service.load_table(i["path"]), "maps": cmp_cfg.get("maps", {}).get(name, {})}
        for name, i in cmp_cfg.get("tables", {}).items()
    ]
    d = os.path.join(UPLOAD_DIR, iid)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "对比方案.json")
    config_io.save_config_file(path, primary, cmp_cfg.get("primaryFields", []), others, cmp_cfg.get("tolerance", 0.0))
    return {"path": path}
