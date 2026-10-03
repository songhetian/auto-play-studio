"""图像素材库的 HTTP 路由。

只做三件事：校验入参、调库、把异常翻成前端看得懂的状态码。
真正的逻辑在 image_library（素材本身）/ image_refs（引用关系）/ screen_capture（采集）里。

⚠️ 路由声明顺序有讲究：`/images/audit` 必须写在 `/images/{asset_id}` 之前，
否则 "audit" 会被当成一个素材 id 吃掉（/instances/{iid}/{action} 就踩过这个坑）。
"""
from __future__ import annotations

import os

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from . import image_library, image_refs, screen_capture
from .driver import DriverUnavailable

router = APIRouter(prefix="/images", tags=["images"])

_RAW_MEDIA = {".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp"}


def get_grabber() -> screen_capture.Grabber:
    """截图实现走依赖注入：真实环境是真抓屏，测试里换成假的即可。"""
    return screen_capture.default_grabber


class CapturePayload(BaseModel):
    """区域截图请求：区域摊平写成 x/y/width/height，前端好拼。

    宽高这里只校验类型，范围为不为 0 交给 screen_capture.validate_region ——
    否则同一条规则有两个真值源，错误形态也会不一致（422 vs 400）。
    """

    name: str = ""
    x: int
    y: int
    width: int = Field(description="区域宽（像素）")
    height: int = Field(description="区域高（像素）")
    tag: str = image_library.DEFAULT_TAG
    threshold: float = image_library.DEFAULT_THRESHOLD


class UpdatePayload(BaseModel):
    name: str | None = None
    tag: str | None = None
    threshold: float | None = Field(default=None, ge=0.5, le=1)


def _not_found(asset_id: str) -> HTTPException:
    return HTTPException(404, f"素材不存在：{asset_id}")


def _suffix(path: str) -> str:
    return os.path.splitext(path)[1].lower()


def _view(asset: dict) -> dict:
    """统一响应形状：每个返回素材的接口都带上 refCount。

    否则前端得猜「这个接口有没有这个字段」—— 列表页有、上传页没有，
    是最容易写出 undefined 的那类 bug。
    """
    return {**asset, "refCount": len(image_refs.find_references(asset["id"]))}


# ── 只看不改的接口：都写在 /{asset_id} 之前 ──────────────────


@router.get("")
def list_images() -> list[dict]:
    """素材列表，带每个素材被几条指令引用（列表上要显示「被引用」角标）。"""
    refs = image_refs.reference_map()
    return [{**asset, "refCount": len(refs.get(asset["id"], []))} for asset in image_library.list_images()]


@router.get("/audit")
def audit() -> list[dict]:
    """体检：引用了不存在的素材 / 素材文件丢了。"""
    return image_refs.audit()


# ── 新增素材 ────────────────────────────────────────────────


@router.post("")
async def upload(
    file: UploadFile = File(...),
    name: str = Form(""),
    tag: str = Form(image_library.DEFAULT_TAG),
    threshold: float = Form(image_library.DEFAULT_THRESHOLD),
) -> dict:
    """上传一张图进素材库。展示名默认取文件名（去掉扩展名）。"""
    data = await file.read()
    fallback = os.path.splitext(file.filename or "")[0]
    try:
        return _view(image_library.import_image(name or fallback, data, tag=tag, threshold=threshold))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/capture")
def capture(payload: CapturePayload, grabber: screen_capture.Grabber = Depends(get_grabber)) -> dict:
    """框选一块屏幕区域，直接存成素材。"""
    try:
        asset = screen_capture.capture_into_library(
            payload.name,
            (payload.x, payload.y, payload.width, payload.height),
            grabber=grabber,
            tag=payload.tag,
            threshold=payload.threshold,
        )
    except ValueError as exc:  # 区域非法 / 抓到的不是图片
        raise HTTPException(400, str(exc)) from exc
    except DriverUnavailable as exc:  # 缺 pyautogui / Pillow
        raise HTTPException(503, str(exc)) from exc
    return _view(asset)


# ── 单个素材 ────────────────────────────────────────────────


@router.get("/{asset_id}")
def get_asset(asset_id: str) -> dict:
    asset = image_library.get_image(asset_id)
    if asset is None:
        raise _not_found(asset_id)
    return _view(asset)


@router.get("/{asset_id}/references")
def references(asset_id: str) -> list[dict]:
    """谁在用它：实例名 + 第几条指令。删除前弹确认框要用这个。"""
    if image_library.get_image(asset_id) is None:
        raise _not_found(asset_id)
    return image_refs.find_references(asset_id)


@router.get("/{asset_id}/raw")
def raw(asset_id: str) -> FileResponse:
    """原图字节。前端 <img src="/api/images/{id}/raw"> 直接显示，不用转 base64。"""
    asset = image_library.get_image(asset_id)
    if asset is None:
        raise _not_found(asset_id)
    return FileResponse(
        asset["path"],
        media_type=_RAW_MEDIA.get(_suffix(asset["path"]), "application/octet-stream"),
        filename=asset["id"] + _suffix(asset["path"]),
    )


@router.patch("/{asset_id}")
def update_asset(asset_id: str, payload: UpdatePayload) -> dict:
    """改展示名 / 标签 / 阈值。文件与 id 不变，已引用它的指令自动跟着生效。"""
    updated = image_library.update_image(
        asset_id, name=payload.name, tag=payload.tag, threshold=payload.threshold
    )
    if updated is None:
        raise _not_found(asset_id)
    return _view(updated)


@router.delete("/{asset_id}")
def delete_asset(asset_id: str, force: bool = Query(False)) -> JSONResponse:
    """删素材。被引用时返回 409 + 引用清单，让用户决定要不要强删。"""
    if image_library.get_image(asset_id) is None:
        raise _not_found(asset_id)
    try:
        result = image_refs.delete_with_policy(asset_id, force=force)
    except image_refs.ImageInUse as exc:
        return JSONResponse(status_code=409, content={"message": str(exc), "refs": exc.refs})
    return JSONResponse(status_code=200, content=result)


__all__ = ["router", "get_grabber"]
