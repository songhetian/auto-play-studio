"""自动化引擎 HTTP + WebSocket 服务（前端经 /api 代理访问）。"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import uuid
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import db
from . import excel
from . import image_routes
from . import snapshot_routes
from . import plans
from . import recovery
from . import screen_lock
from . import summary
from . import template_routes
from .screen_lock import ScreenBusy
from .assist import routes as assist_routes
from .kb import routes as kb_routes
from .phrases import routes as phrase_routes
from .sensitive_words import routes as sensitive_routes
from . import violation_routes
from . import daily_summary_routes
from . import daily_summary as daily_summary_mod
from . import video_routes
from .excel_prep import routes as excel_prep_routes
from .excel_toolbox import routes as excel_toolbox_routes
from .compare import routes as compare_routes
from .providers import MAX_QUERY_NUMBERS, build_provider, parse_numbers, query_numbers
from .runner import drop_runner, get_runner

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """启动时抓住事件循环：runner 线程要往 WebSocket 推日志必须用它。

    同时做崩溃恢复：把上次崩溃残留的 running/paused/stopping/starting 复位成可重跑状态。
    """
    global LOOP
    LOOP = asyncio.get_running_loop()
    recovery.recover_on_startup()
    # 词库文件监听：主管分发 wordlib.json 时自动导入（未配路径时空转，零开销）
    from .sensitive_words import watch as wordlib_watch

    wordlib_watch.start_watcher()
    # 每日汇总播报：到点发当天违禁词汇总 + 后台补发 pending（断网兜底）
    asyncio.create_task(daily_summary_mod.run_scheduler())
    asyncio.create_task(daily_summary_mod.run_retry())
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
api.include_router(snapshot_routes.router)
api.include_router(template_routes.router)
api.include_router(assist_routes.router)
api.include_router(kb_routes.router)
api.include_router(excel_prep_routes.router)
api.include_router(excel_toolbox_routes.router)
api.include_router(phrase_routes.router)
api.include_router(sensitive_routes.router)
api.include_router(violation_routes.router)
api.include_router(daily_summary_routes.router)
api.include_router(video_routes.router)

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
            "sendIntervalMs": 500,
            "skipSuccess": True,
            "writeReason": True,
            "backup": True,
            "cmds": [],
            # 上传 Excel 后才会填；预置成空数组，前端读 .length 才不会炸
            "columns": [],
        },
        "hotkeys": {"run": "F8", "toggle": "F9", "stop": "F10", "scope": "window"},
    },
    "guard": {
        "tool": "guard",
        "window": "",
        "guard": {
            "captureMode": "auto",
            # 默认允许剪贴板降级：京麦/钉钉/飞鸽这类自绘客户端不暴露标准 UIA，
            # 关掉它这些软件就完全没法监控。界面上是可见开关，用户可自行关。
            "allowClipboard": True,
            "levels": ["high", "mid", "low"],
            "pollMs": 800,
        },
        "hotkeys": {"run": "F8", "toggle": "F9", "stop": "F10", "scope": "window"},
    },
    "guard": {
        "tool": "guard",
        "window": "",
        "guard": {
            "captureMode": "auto",
            # 默认允许剪贴板降级：京麦/钉钉/飞鸽这类自绘客户端不暴露标准 UIA，
            # 关掉它这些软件就完全没法监控。界面上是可见开关，用户可自行关。
            "allowClipboard": True,
            "levels": ["high", "mid", "low"],
            "pollMs": 800,
        },
        "hotkeys": {"run": "F8", "toggle": "F9", "stop": "F10", "scope": "window"},
    },
    "monitor": {
        "tool": "monitor",
        "region": "full",
        "rules": [],
        "alertSound": {"preset": "voice", "text": "", "customPath": ""},
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
    #: 从哪个方案起手。方案只是「把配置拷一份过来」，之后与实例互不影响。
    planId: str | None = None


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
    # 局部变量不能叫 plans：它会在整个函数里盖掉同名的方案模块
    restored = recovery.recover_on_startup()
    return {
        "recovered": len(restored),
        "plans": [
            {
                "id": p.instance_id,
                "name": p.name,
                "from": p.from_status,
                "to": p.to_status,
                "done": p.progress_done,
                "total": p.progress_total,
            }
            for p in restored
        ],
    }


@api.get("/instances/recovery")
def recovery_summary_endpoint():
    """返回引擎启动时那次崩溃恢复的结果，供前端在控制台展示「已恢复 N 个被中断实例」。"""
    # 局部变量不能叫 plans：它会在整个函数里盖掉同名的方案模块
    restored = recovery.recent_recoveries()
    return {
        "recovered": len(restored),
        "plans": [
            {
                "id": p.instance_id,
                "name": p.name,
                "from": p.from_status,
                "to": p.to_status,
                "done": p.progress_done,
                "total": p.progress_total,
            }
            for p in restored
        ],
    }


@api.post("/instances")
def create_instance(p: CreatePayload):
    config = DEFAULT_CONFIG.get(p.tool, {})
    if p.planId:
        found = plans.get_plan(p.planId)
        if not found:
            raise HTTPException(404, "方案不存在")
        if found["tool"] != p.tool:
            raise HTTPException(
                400, f"方案「{found['name']}」是 {found['tool']} 的配置，套不到 {p.tool} 实例上"
            )
        # 以默认配置为底：方案可以只写关心的那几项，缺的由默认值补齐
        config = plans.deep_merge(config, found["config"])

    iid = f"{p.tool[:1].upper()}{uuid.uuid4().hex[:4]}"
    with db.write() as c:
        c.execute(
            "INSERT INTO instances(id, tool, name, config_json) VALUES (?,?,?,?)",
            (iid, p.tool, p.name, json.dumps(config, ensure_ascii=False)),
        )
    db.log(iid, f"实例已创建：{p.name}")
    return {"id": iid, "name": p.name, "tool": p.tool, "status": "idle", "done": 0, "total": 0,
            "config": config}


@api.put("/instances/{iid}/config")
def save_config(iid: str, config: dict):
    db.save_config(iid, config)
    return {"ok": True}


@api.post("/instances/{iid}/logi-probe")
def logi_probe(iid: str, body: dict = None):
    """物流查询连通性自检：跑大批量之前先花两秒探一次路。

    返回 ``{ok, stage, message, missing?, sample?}``：
    - ``stage="config"`` 卡在配置（缺密钥 / 缺选择器），**不出网**
    - ``stage="query"`` 真的去查了一个测试单号

    为什么必须要有它：用户要求"一定要保证能查询到"，但代码保证不了 ——
    密钥没配、单号格式不对、官网改版、撞验证码，任何一条都会让查询失败，
    而默认表现是跑完整批任务后得到一列"无轨迹"，看不出是哪一步错的。
    自检把"卡在哪一步"直接说出来。

    自检**不写缓存**（用一个不存在的测试单号，且绕过缓存写入），
    否则试跑结果会占掉正式查询的缓存。
    """
    rows = db.query("SELECT config_json FROM instances WHERE id=?", (iid,))
    if not rows:
        raise HTTPException(404, "实例不存在")
    cfg = json.loads(rows[0]["config_json"])
    logi = cfg.get("logi") or {}
    kind = logi.get("provider", "excel")

    # ── 配置层：不满足就别出网 ──
    if kind == "api":
        if not (logi.get("apiKey") or "").strip():
            return {"ok": False, "stage": "config", "message":
                    "还没填快递100 密钥：到 kuaidi100.com 注册后在「我的信息」拿客户号(CustomerKey)，"
                    "和密钥一起填进「接口密钥」。没配这个，接口方式一定查不出数据。"}
    elif kind == "web":
        site = logi.get("site") or {}
        need = ["url", "input", "button", "result", "status", "trace"]
        missing = [k for k in need if not (site.get(k) or "").strip()]
        if missing:
            return {"ok": False, "stage": "config", "missing": missing, "message":
                    "站点配置还缺：%s。缺这几项跑起来只会得到一句「无轨迹」，看不出错在哪。"
                    % "、".join(missing)}
    elif kind == "excel":
        if not logi.get("refFile"):
            return {"ok": False, "stage": "config", "message":
                    "Excel 匹配合并需要先选一张对照表（含物流单号列与物流状态列）。"}

    # ── 查询层：用一个不存在的测试单号探一次 ──
    # 真实存在的单号不能拿来试：会产生一条假的物流记录、也白花一次接口额度
    no = "0000000000000000000000"
    try:
        p = build_provider(logi)
        # no_cache：自检既不读也不写缓存，否则假单号会占掉正式查询的记录
        r = p.query(no, no_cache=True)
    except ValueError as e:
        return {"ok": False, "stage": "query", "message": str(e)}
    except Exception as e:  # 兜底：自检绝不能自己炸掉
        return {"ok": False, "stage": "query", "message": "自检时发生未预期的错误：%s" % e}

    # 走到这里说明请求成功返回了。测试单号本来查不到，所以
    # "查到了" 反而说明接口被改成了什么都返回成功 —— 那不算通路
    got = r.status or "无内容"
    if got not in ("查无结果", "无轨迹"):
        return {"ok": False, "stage": "query", "message":
                "接口可达且密钥有效（测试单号返回了「%s」，本该是查无结果）。"
                "这不影响正式查询，但说明该接口的返回与常规不一致，值得留意。" % got}
    return {"ok": True, "stage": "query", "sample": {"status": got, "trace": (r.trace or "")[:200]}, "message":
            "接口通了：密钥有效、网络可达、快递100 正常响应。"}


@api.post("/instances/{iid}/logi-query")
def logi_query(iid: str, body: dict = None):
    """快速查单：给一个或几个单号，立刻返回各自状态。

    与整批跑的区别是**单号驱动**、不依赖上传文件，入口在手边、结果可复制。
    查询方式跟随实例已配置的 provider（Excel/网页/接口），不另起一套语义。
    """
    rows = db.query("SELECT config_json FROM instances WHERE id=?", (iid,))
    if not rows:
        raise HTTPException(404, "实例不存在")
    cfg = json.loads(rows[0]["config_json"])
    logi = cfg.get("logi") or {}

    numbers = parse_numbers((body or {}).get("numbers") or "")
    if not numbers:
        raise HTTPException(400, "还没有输入单号，请粘贴一个或多个物流单号（每行一个）")
    if len(numbers) > MAX_QUERY_NUMBERS:
        raise HTTPException(400, "一次最多查 %d 个单号，当前 %d 个，请分批查询" % (MAX_QUERY_NUMBERS, len(numbers)))

    try:
        provider = build_provider(logi)
    except ValueError as e:
        raise HTTPException(400, str(e))
    items = query_numbers(provider, numbers)
    return {"items": items, "count": len(items)}


@api.get("/instances/{iid}/logi-recent")
def logi_recent(iid: str, limit: int = 10):
    """最近查过的单号（按最后更新时间倒序）—— 刷新页面后还能一键重查。"""
    rows = db.query("SELECT id FROM instances WHERE id=?", (iid,))
    if not rows:
        raise HTTPException(404, "实例不存在")
    limit = max(1, min(int(limit or 10), 200))
    recs = db.query(
        "SELECT no, company, status, signed_at, trace, updated_at FROM waybill_cache "
        "ORDER BY updated_at DESC, no DESC LIMIT ?",
        (limit,),
    )
    return {"items": [dict(r) for r in recs], "count": len(recs)}


@api.patch("/instances/{iid}")
def rename(iid: str, p: dict):
    """改名。名字是用户给实例起的唯一标识，建完就该能改 —— 否则只能用
    「rpa-4f2a」这类系统 ID 认人，实例一多根本分不清谁是谁。"""
    name = (p.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "名字不能为空")
    if len(name) > 60:
        raise HTTPException(400, "名字太长了（最多 60 字）")
    rows = db.query("SELECT name FROM instances WHERE id=?", (iid,))
    if not rows:
        raise HTTPException(404, "实例不存在")
    old = rows[0]["name"]
    if old == name:
        return {"ok": True, "name": name}
    with db.write() as c:
        c.execute("UPDATE instances SET name=? WHERE id=?", (name, iid))
    db.log(iid, f"实例已改名：{old} → {name}")
    return {"ok": True, "name": name, "old": old}


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
        raise HTTPException(409, screen_lock.busy_detail(busy)) from busy
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
    # 先停线程、摘注册表，再删数据行：monitor/guard 的循环是 `while not stop`，
    # 只删行会让它继续无限轮询屏幕、继续落命中与通知。
    runner = drop_runner(iid)
    if runner is not None:
        try:
            runner.stop()
        except Exception:  # noqa: BLE001 — 删除不能被「停不下来」挡住
            pass
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


def webhook_poster():
    """webhook 的真发信器。**测试可覆盖这个依赖**（覆盖必须挂在 `api` 子应用上）。"""
    from .notify.webhook import post_json

    return post_json


@api.post("/settings/notify/test")
def test_notify(poster=Depends(webhook_poster)):
    """发一条样例通知，回逐通道结果 —— 让用户当场知道地址填得对不对。

    刻意**绕过级别路由**，走所有启用的通道：它验的是通道本身配得对不对。
    若受路由约束，用户配了 webhook 却因为 alert 没路由到它而什么都不发，会以为自己填错了。

    失败原因原样回给界面（不抛 500）：用户得知道该改什么。
    """
    from .notify import deliver
    from .notify.model import NotifyPayload
    from .notify.report import build_channels

    cfg = db.get_notify_config()
    channels = build_channels(cfg, poster=poster)
    payload = NotifyPayload(
        title="测试通知", detail="这是来自 AutoPlay Studio 的测试发送", level="alert", matched_by="test"
    )
    return deliver(payload, channels, {payload.level: [c.name for c in channels]})


@api.get("/hit-events/unread-count")
def hit_events_unread_count():
    """未读命中数：托盘角标与事件列表页的红点用它。"""
    return {"count": db.unread_count()}


@api.post("/hit-events/read")
def hit_events_mark_read(payload: dict):
    """标记已读。`ids` 为空 = 全部标记。回本次真正被标记的条数。"""
    ids = (payload or {}).get("ids") or None
    return {"marked": db.mark_hits_read(ids)}


@api.post("/hit-events/ack")
def hit_events_ack(payload: dict):
    """确认命中事件（已处理，闭环）。`ids` 为空 = 全部确认。回本次真正被确认的条数。

    与「标记已读」分开：已读是「看过了」，确认是「管过了」。
    已读顶多让角标清零，确认才回答「这条告警有人负责」。
    """
    ids = (payload or {}).get("ids") or None
    return {"acked": db.ack_hit_events(ids)}


@api.get("/hit-events")
def hit_events(
    instanceId: str | None = None,
    tool: str | None = None,
    level: str | None = None,
    limit: int = 200,
    beforeId: int | None = None,
    unreadOnly: bool = False,
):
    """跨实例检索命中事件（最新在前）。

    「这条规则一共命中过几次、在哪些实例上」要能一次问出来，所以筛选条件都在这一个端点上；
    `beforeId` 是向后翻页的游标（取上一页最后一条的 id）。
    """
    return db.list_hit_events(
        instance_id=instanceId, tool=tool, level=level, limit=limit,
        before_id=beforeId, unread_only=unreadOnly,
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
    # openpyxl 读不了老版 .xls 与 csv；硬读只会抛后端异常（500），
    # 不如在这里说清楚「另存为 .xlsx」—— 解析层用的也是同一套 openpyxl。
    if suffix not in {".xlsx", ".xlsm"}:
        raise HTTPException(400, "仅支持 .xlsx / .xlsm；老版 .xls 与 csv 请先用 Excel 另存为 .xlsx")
    dst = os.path.join(tempfile.gettempdir(), "autoplay", iid + suffix)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    content = await file.read()
    with open(dst, "wb") as f:
        f.write(content)

    try:
        columns = excel.detect_columns(dst)
        rows = excel.count_rows(dst)
    except Exception as exc:  # noqa: BLE001 — 读不动就说人话，别把后端异常甩给用户
        raise HTTPException(400, "这个文件读不出来（%s）。请确认是标准 .xlsx，或另存为 .xlsx 再传" % exc) from exc
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


# ── 方案（配置模板）──────────────────────────────────────────
# 方案是「配置模板层」，实例是「运行主体层」：全局存一份，跨工具、跨实例复用。
# 它跟实例只接触一次 —— 「新建实例时套一份过来」，之后互不影响（见 create_instance）。


class PlanCreate(BaseModel):
    tool: str
    name: str
    config: dict = {}


class PlanPatch(BaseModel):
    name: str | None = None
    config: dict | None = None


@api.get("/plans")
def list_plans_endpoint(tool: str | None = None):
    return plans.list_plans(tool)


@api.post("/plans")
def create_plan_endpoint(p: PlanCreate):
    # 方案挂在工具上：工具号不存在的话，新建实例时这个方案谁都套不上，当场拦掉
    if p.tool not in DEFAULT_CONFIG:
        raise HTTPException(400, f"未知工具：{p.tool}")
    return {"id": plans.create_plan(p.tool, p.name, p.config)}


@api.get("/plans/{pid}")
def read_plan_endpoint(pid: str):
    found = plans.get_plan(pid)
    if not found:
        raise HTTPException(404, "方案不存在")
    return found


@api.patch("/plans/{pid}")
def patch_plan_endpoint(pid: str, p: PlanPatch):
    if not plans.update_plan(pid, name=p.name, config=p.config):
        raise HTTPException(404, "方案不存在")
    return plans.get_plan(pid)


@api.delete("/plans/{pid}")
def remove_plan_endpoint(pid: str):
    if not plans.delete_plan(pid):
        raise HTTPException(404, "方案不存在")
    return {"ok": True}


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
