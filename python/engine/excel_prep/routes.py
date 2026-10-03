"""Excel 预处理的 HTTP 路由（挂在 /api/excel 下）。

路由只做参数校验与错误码，业务都在 `service` 里。
返回体已经是 camelCase（`service` 拼好的），这里不再翻译一遍。
"""
from __future__ import annotations

import os
from typing import Any, Callable, TypeVar

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import service

router = APIRouter(prefix="/excel", tags=["excel"])

T = TypeVar("T")


class CleanIn(BaseModel):
    path: str
    keyCol: str = ""
    acceptRisk: bool = False


class PathIn(BaseModel):
    path: str


def _guard(fn: Callable[[], T]) -> T:
    """异常 → 状态码，只写这一处。

    `LookupError` 是「你给的东西不在我这儿」（文件不存在、不在白名单）→ 404；
    `ValueError` 是「你给的参数不对」（主键列写错）→ 400 ——
    两者都不该以 500 的形式出现在用户面前，那样他只会看到一句「服务异常」。
    """
    try:
        return fn()
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (ValueError, service.Unreadable) as exc:
        raise HTTPException(400, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(400, f"打不开：{exc}") from exc


@router.get("/inspect")
def inspect_endpoint(path: str = "", keyCol: str = "") -> dict[str, Any]:
    """只读体检。`keyCol` 可以留空（用户还没选主键列时页面也要能显示列名）。"""
    return _guard(lambda: service.inspect_file(path, keyCol))


@router.post("/clean")
def clean_endpoint(body: CleanIn) -> dict[str, Any]:
    """整理出新文件并返回台账。原文件只读。"""
    return _guard(lambda: service.clean_file(body.path, body.keyCol, body.acceptRisk))


@router.get("/download")
def download_endpoint(path: str = "") -> FileResponse:
    """把整理产出的文件发回去 —— 只有产出过的路径能通过。"""
    target = _guard(lambda: service.produced_file(path))
    return FileResponse(target, filename=os.path.basename(target))


@router.post("/open")
def open_endpoint(body: PathIn) -> dict[str, bool]:
    """用系统默认程序打开整理产出的文件（引擎与本机同一个桌面）。"""
    _guard(lambda: service.open_file(body.path))
    return {"ok": True}
