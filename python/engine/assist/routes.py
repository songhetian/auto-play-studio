"""速查填入的 HTTP 路由（挂在 `/api/assist` 下）。

路由只做参数校验与错误码，业务全在 `service` 里。

错误码分两档，因为用户要做的事不同：
- **400** = 这次请求本身没意义（没框过、话术是空的、窗口找不到了）→ 用户去改配置或输入
- **409** = 环境不让（屏幕被别的实例占着）→ 用户去停那个实例
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from engine.driver import DriverUnavailable
from engine.screen_lock import ScreenBusy, busy_detail
from engine import window_control

from . import service

router = APIRouter(prefix="/assist", tags=["assist"])


class TargetIn(BaseModel):
    """框选结果。字段名与 `Target` 一致，省掉一层翻译。"""

    window: str = ""
    x: int = 0
    y: int = 0
    width: int = 0
    height: int = 0


class FillIn(BaseModel):
    text: str = ""


@router.get("/windows")
def list_open_windows() -> dict:
    """当前打开的窗口标题，给「填到哪个窗口」当候选。

    让用户从真实存在的标题里挑，而不是自己猜一个 —— 猜错了
    `activate_window` 找不到窗口，点了「填入」只会得到一句报错。

    枚举不了就回空列表 + 为什么，前端据此退回手填，而不是把一个永远是空的下拉框摆着。
    """
    try:
        found = window_control.list_windows()
    except DriverUnavailable as e:
        return {"windows": [], "reason": str(e)}
    return {"windows": sorted({t for _, t in found if (t or "").strip()}), "reason": ""}


@router.get("/target")
def get_target() -> dict:
    target = service.get_target()
    return {"target": target.as_dict() if target else None}


@router.put("/target")
def put_target(body: TargetIn) -> dict:
    try:
        target = service.Target(
            window=body.window,
            x=body.x,
            y=body.y,
            width=body.width,
            height=body.height,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"target": service.save_target(target).as_dict()}


@router.post("/fill")
def fill(body: FillIn) -> dict:
    """把一段话术填进框定的输入框。**只填不发送** —— 发送键由客服自己按。"""
    try:
        target = service.fill_saved(body.text or "")
    except service.NoTarget as e:
        raise HTTPException(400, str(e)) from e
    except ValueError as e:  # 空话术
        raise HTTPException(400, str(e)) from e
    except DriverUnavailable as e:  # 目标窗口没开着
        raise HTTPException(400, str(e)) from e
    except ScreenBusy as busy:
        raise HTTPException(409, busy_detail(busy)) from busy
    return {"filled": True, "window": target.window}
