"""自动化引擎 HTTP + WebSocket 服务（前端经 /api 代理访问）。"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import db
from . import excel
from . import image_routes
from . import recovery
from . import screen_lock
from . import summary
from . import template_routes
from .screen_lock import ScreenBusy
from .kb import routes as kb_routes
from .excel_prep import routes as excel_prep_routes
from .compare import routes as compare_routes
from .runner import get_runner

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """启动时抓住事件循环：runner 线程要往 WebSocket 推日志必须用它。

    同时做崩溃恢复：把上次崩溃残留的 running/paused/stopping/starting 复位成可重跑状态。
    """
    global LOOP
    LOOP = asyncio.get_running_loop()
    recovery.recover_on_startup()
    yield


app = FastAPI(title="AutoPlay Engine", lifespan=lifespan)
# 打包后渲染进程以 file:// 加载（Origin 为 null），访问本机 127.0.0.1 引擎属跨域，必须放行。
# 引擎只监听回环地址、不携带凭证，故允许任意来源。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
api = FastAPI()  # 挂载在 /api，与前端 api.ts 对齐
api.include_router(compare_routes.router)
api.include_router(image_routes.router)
api.include_router(template_routes.router)
api.include_router(kb_routes.router)
api.include_router(excel_prep_routes.router)

WS_CLIENTS: dict[str, set[WebSocket]] = {}


def _broadcast(instance_id: str, message: str) -> None:
    for ws in list(WS_CLIENTS.get(instance_id, [])):
        try:
            asyncio.run_coroutine_threadsafe(ws.send_text(message), LOOP)
        except Exception:  # noqa: BLE001
            pass


LOOP = None  # 启动时赋值


def _on_log(instance_id: str):
    def _fn(message: str):
        db.log(instance_id, message)
        _broadcast(instance_id, message)

    return _fn


DEFAULT_CONFIG: dict[str, dict] = {
    "rpa": {
        "tool": "rpa",
        "window": "",
        "rpa": {
            "excelPath": "",
            "colName": "客户名称",
            "colMsg": "",
            "colStatus": "",
            "unified": False,
            "unifiedText": "",
            "from": 2,
            "to": 2,
            "retry": 2,
            "onFail": "continue",
            "skipSuccess": True,
            "writeReason": True,
            "backup": True,
            "cmds": [],
            # 上传 Excel 后才会填；预置成空数组，前端读 .length 才不会炸
            "columns": [],
        },
        "hotkeys": {"run": "F8", "toggle": "F9", "stop": "F10", "scope": "window"},
    },
    "monitor": {
        "tool": "monitor",
        "region": "full",
        "rules": [],
        "hotkeys": {"run": "F8", "toggle": "F9", "stop": "F10", "scope": "window"},
    },
    "cmp": {
        "tool": "cmp",
        "cmp": {
            "primaryFile": "",
            "primaryColumns": [],
            "primaryFields": [],
            "otherFiles": [],
            "tables": {},
            "maps": {},
            "tolerance": 0.0,
            "outFile": "",
        },
        "hotkeys": {"run": "F8", "toggle": "F9", "stop": "F10", "scope": "window"},
    },
    "logi": {
        "tool": "logi",
        "logi": {
            "file": "",
            "colWaybill": "物流单号",
            "provider": "excel",
            "intervalMs": 1500,
            "retry": 2,
            "pauseOnCaptcha": True,
            "columns": [],
        },
        "hotkeys": {"run": "F8", "toggle": "F9", "stop": "F10", "scope": "window"},
    },
    "macro": {
        "tool": "macro",
        # 必填：宏就是「在某个窗口里按几下」，没有目标窗口就不知道该往哪儿按键。
        # 与 rpa 不同的是这里不放开空值 —— 引擎会直接拒绝执行（见 runner._run_macro）。
        "window": "",
        "macro": {
            "cmds": [],
        },
        "hotkeys": {"run": "F8", "toggle": "F9", "stop": "F10", "scope": "window"},
    },
}


class CreatePayload(BaseModel):
    name: str
    tool: str


@api.get("/instances")
def list_instances():
    rows = db.query("SELECT * FROM instances ORDER BY created_at DESC")
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "name": r["name"],
                "tool": r["tool"],
                "status": r["status"],
                "done": r["progress_done"],
                "total": r["progress_total"],
                "config": json.loads(r["config_json"]),
                "updatedAt": 0,
            }
        )
    return out


@api.post("/instances/recover")
def recover_instances_endpoint():
    """手动触发崩溃恢复对账：把残留的 live 状态复位，返回恢复数量与明细。

    引擎启动时已自动跑过一次；这个端点给前端在「重新同步状态」时调用，
    也能在测试里直接验证对账结果。
    """
    plans = recovery.recover_on_startup()
    return {
        "recovered": len(plans),
        "plans": [
            {
                "id": p.instance_id,
                "name": p.name,
                "from": p.from_status,
                "to": p.to_status,
                "done": p.progress_done,
                "total": p.progress_total,
            }
            for p in plans
        ],
    }


@api.get("/instances/recovery")
def recovery_summary_endpoint():
    """返回引擎启动时那次崩溃恢复的结果，供前端在控制台展示「已恢复 N 个被中断实例」。"""
    plans = recovery.recent_recoveries()
    return {
        "recovered": len(plans),
        "plans": [
            {
                "id": p.instance_id,
                "name": p.name,
                "from": p.from_status,
                "to": p.to_status,
                "done": p.progress_done,
                "total": p.progress_total,
            }
            for p in plans
        ],
    }


@api.post("/instances")
def create_instance(p: CreatePayload):
    iid = f"{p.tool[:1].upper()}{uuid.uuid4().hex[:4]}"
    with db.write() as c:
        c.execute(
            "INSERT INTO instances(id, tool, name, config_json) VALUES (?,?,?,?)",
            (iid, p.tool, p.name, json.dumps(DEFAULT_CONFIG.get(p.tool, {}), ensure_ascii=False)),
        )
    db.log(iid, f"实例已创建：{p.name}")
    return {"id": iid, "name": p.name, "tool": p.tool, "status": "idle", "done": 0, "total": 0,
            "config": DEFAULT_CONFIG.get(p.tool, {})}


@api.put("/instances/{iid}/config")
def save_config(iid: str, config: dict):
    db.save_config(iid, config)
    return {"ok": True}


@api.post("/instances/{iid}/control/{action}")
def control(iid: str, action: str):
    r = get_runner(iid, _on_log(iid))
    fn = {"start": r.start, "pause": r.pause, "resume": r.resume, "stop": r.stop}.get(action)
    if not fn:
        raise HTTPException(400, f"未知动作：{action}")
    try:
        ok = fn()
    except ScreenBusy as busy:
        # 抢不到屏幕要说出是谁占着 —— 只回一句状态码，用户只能自己去猜该停哪一个
        rows = db.query("SELECT name FROM instances WHERE id=?", (busy.holder_id,))
        holder = rows[0]["name"] if rows else busy.holder_id
        raise HTTPException(
            409, f"屏幕正被「{holder}」占用：动键鼠的实例同一时刻只能跑一个，先停掉它或等它跑完"
        ) from busy
    if not ok:
        raise HTTPException(409, f"当前状态不允许该操作（status={r.status()}）")
    return {"ok": True, "status": r.status()}


@api.post("/instances/{iid}/clone")
def clone(iid: str):
    src = db.query("SELECT * FROM instances WHERE id=?", (iid,))
    if not src:
        raise HTTPException(404, "实例不存在")
    s = src[0]
    new_id = f"{s['tool'][:1].upper()}{uuid.uuid4().hex[:4]}"
    with db.write() as c:
        c.execute(
            "INSERT INTO instances(id, tool, name, config_json) VALUES (?,?,?,?)",
            (new_id, s["tool"], s["name"] + " 副本", s["config_json"]),
        )
    return {"id": new_id, "name": s["name"] + " 副本", "tool": s["tool"], "status": "idle",
            "done": 0, "total": 0, "config": json.loads(s["config_json"])}


@api.delete("/instances/{iid}")
def remove(iid: str):
    with db.write() as c:
        c.execute("DELETE FROM instances WHERE id=?", (iid,))
    return {"ok": True}


@api.get("/instances/{iid}/rows")
def rows(iid: str):
    last = db.query("SELECT id FROM runs WHERE instance_id=? ORDER BY id DESC LIMIT 1", (iid,))
    if not last:
        return []
    # 字段名跟前端 `Row`（src/schemas/instance.ts）对齐。这里曾经回 snake_case，
    # 前端读 camelCase：页面不报错，但整张「执行明细」的步数、关键字、耗时全是空白。
    return [
        {
            "rowNo": r["row_no"],
            "keyValue": r["key_value"],
            "status": r["status"],
            "message": r["message"],
            "durationMs": r["duration_ms"],
        }
        for r in db.query(
            "SELECT row_no, key_value, status, message, duration_ms FROM rows WHERE run_id=? ORDER BY row_no",
            (last[0]["id"],),
        )
    ]


@api.get("/instances/{iid}/logs")
def logs(iid: str):
    return db.query("SELECT ts, level, message FROM logs WHERE instance_id=? ORDER BY id DESC LIMIT 200", (iid,))


@api.get("/instances/{iid}/monitor-hits")
def monitor_hits(iid: str):
    """桌面监控的命中事件（最新在前），运行详情页的「命中记录」用它。"""
    return db.list_monitor_hits(iid)


@api.get("/notifications/outbox")
def notifications_outbox(since: int = 0):
    """待发的桌面通知（Electron 主进程轮询它，拿到后真正弹出 + 更新托盘角标）。

    引擎是 sidecar，自己弹不了 Windows 通知；而监控是常驻盯屏的，
    不能指望实例窗口一直开着。所以由主进程来取 —— 窗口关了也照样收得到。
    """
    from .notify import outbox

    items, cursor = outbox.drain(since)
    return {"items": items, "cursor": cursor}


@api.get("/settings/notify")
def get_notify():
    """通知配置（通道启停 + 每个级别走哪些通道）。"""
    return db.get_notify_config()


@api.put("/settings/notify")
def put_notify(patch: dict):
    """合入一块通知配置，回完整配置。"""
    return db.save_notify_config(patch)


@api.get("/hit-events")
def hit_events(
    instanceId: str | None = None,
    tool: str | None = None,
    level: str | None = None,
    limit: int = 200,
    beforeId: int | None = None,
):
    """跨实例检索命中事件（最新在前）。

    「这条规则一共命中过几次、在哪些实例上」要能一次问出来，所以筛选条件都在这一个端点上；
    `beforeId` 是向后翻页的游标（取上一页最后一条的 id）。
    """
    return db.list_hit_events(
        instance_id=instanceId, tool=tool, level=level, limit=limit, before_id=beforeId
    )


@api.get("/instances/{iid}/summary")
def run_summary(iid: str):
    """最近一轮的结论：一句话 + 失败原因归类 + 待人工确认清单。

    取的轮次与 `/rows` 完全一致（都是最近一次 run）—— 各挑一轮的话，
    页面上半部分说跑了 4 行、下半部分列着 6 行明细。
    """
    last = db.query("SELECT id FROM runs WHERE instance_id=? ORDER BY id DESC LIMIT 1", (iid,))
    if not last:
        return summary.to_payload(summary.summarize([]))
    return summary.to_payload(
        summary.summarize(
            db.query(
                "SELECT row_no, key_value, status, message FROM rows WHERE run_id=? ORDER BY row_no",
                (last[0]["id"],),
            )
        )
    )


@api.post("/instances/{iid}/excel")
async def upload_excel(iid: str, file: UploadFile = File(...)):
    """上传 Excel：保存文件、检测列名与行数，回写配置。"""
    suffix = os.path.splitext(file.filename or "")[1].lower()
    if suffix not in {".xlsx", ".xls", ".csv"}:
        raise HTTPException(400, "仅支持 .xlsx / .xls / .csv")
    dst = os.path.join(tempfile.gettempdir(), "autoplay", iid + suffix)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    content = await file.read()
    with open(dst, "wb") as f:
        f.write(content)

    columns = excel.detect_columns(dst)
    rows = excel.count_rows(dst)
    cfg = db.get_config(iid)
    sample: dict = {}
    if cfg.get("tool") == "rpa":
        rpa = cfg.setdefault("rpa", {})
        rpa["excelPath"] = dst
        # 数据从第 2 行开始：默认区间必须覆盖全部数据，否则一点「开始」什么都不跑
        rpa["from"], rpa["to"] = 2, max(2, rows + 1)
        # 配置页的实时预览要拿真值渲染，用户才看得到 {金额|money} 的真实效果
        sample = excel.sample_row(dst, key_col=str(rpa.get("colName") or ""))
    elif cfg.get("tool") == "logi":
        cfg.setdefault("logi", {})["file"] = dst
    db.save_config(iid, cfg)
    db.log(iid, f"已读取 {file.filename} · 自动识别 {len(columns)} 列 / {rows} 行")
    return {"columns": columns, "rows": rows, "path": dst, "sample": sample}


@api.websocket("/ws/instances/{iid}/logs")
async def ws_logs(websocket: WebSocket, iid: str):
    await websocket.accept()
    WS_CLIENTS.setdefault(iid, set()).add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        WS_CLIENTS[iid].discard(websocket)


app.mount("/api", api)
