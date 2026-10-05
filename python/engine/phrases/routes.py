"""话术库的 HTTP 路由（挂在 /api/phrases 下）。

路由只做参数校验与错误码转换，业务全在 `service` 里。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import service

router = APIRouter(prefix="/phrases", tags=["phrases"])


class PhraseIn(BaseModel):
    title: str
    body: str
    category: str = ""


class PhrasePatch(BaseModel):
    title: str | None = None
    body: str | None = None
    category: str | None = None


@router.get("")
def list_phrases(q: str = "", category: str = "") -> list[dict]:
    """直接返回数组：列表端点不需要再包一层 {"items": ...}，那是给自己增加解构的负担。"""
    return service.list_phrases(q, category)


# 路径必须在 /{pid} 之前注册：FastAPI 按声明顺序匹配，
# 放到后面的话 "categories" 会被当成 pid 去做 int() 然后 422
@router.get("/categories")
def list_categories() -> list[str]:
    return service.categories()


@router.post("")
def create_phrase(body: PhraseIn) -> dict:
    try:
        return service.upsert(body.title, body.body, body.category)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.patch("/{pid}")
def patch_phrase(pid: int, body: PhrasePatch) -> dict:
    try:
        return service.update(pid, body.title, body.body, body.category)
    except KeyError as e:
        raise HTTPException(404, "话术不存在") from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/{pid}")
def delete_phrase(pid: int) -> dict:
    try:
        service.remove(pid)
    except KeyError as e:
        raise HTTPException(404, "话术不存在") from e
    return {"ok": True}


@router.post("/{pid}/use")
def use_phrase(pid: int) -> dict:
    try:
        return service.mark_used(pid)
    except KeyError as e:
        raise HTTPException(404, "话术不存在") from e
