"""Excel 工具箱的 HTTP 路由（挂在 /api/excel-toolbox 下）。

路由只做参数校验与错误码转换，业务都在 `service` 里。
沿用 `excel_prep.routes` 的 `_guard` 分工：
  - LookupError   → 404（东西不在）
  - ValueError / Unreadable → 400（参数不对 / 文件读不了）
"""
from __future__ import annotations

from typing import Any, Callable, TypeVar

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import service

router = APIRouter(prefix="/excel-toolbox", tags=["excel-toolbox"])

T = TypeVar("T")


class ColumnSpec(BaseModel):
    """补全列的列名映射。

    字段名不能叫 `from`（Python 关键字），但前端 JSON 里就该写 `from`
    （和 Excel 那边的"来源列/目标列"是一个词），所以用 alias 收。
    """

    from_: str = Field(alias="from")
    to: str = ""

    model_config = {"populate_by_name": True}


class MergeIn(BaseModel):
    mainPath: str
    srcPath: str
    mainKeys: list[str]
    srcKeys: list[str]
    fillColumns: list[str | ColumnSpec] = []


class GenerateIn(BaseModel):
    path: str
    columns: list[str] = []


class DedupeIn(BaseModel):
    path: str
    keys: list[str] = []


class ConvertIn(BaseModel):
    path: str
    target: str = "csv"


class SplitIn(BaseModel):
    path: str
    column: str


class FilterIn(BaseModel):
    path: str
    column: str = ""
    value: str = ""


class ProblemIn(BaseModel):
    path: str
    keyColumn: str = ""


def _guard(fn: Callable[[], T]) -> T:
    try:
        return fn()
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (ValueError, service.Unreadable) as exc:
        raise HTTPException(400, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(400, f"处理失败：{exc}") from exc


def _fill_cols(items: list[str | ColumnSpec]) -> list[Any]:
    """把 pydantic 对象转回 core 认识的 dict 形状。"""
    return [{"from": c.from_, "to": c.to} if isinstance(c, ColumnSpec) else c for c in items]


@router.get("/columns")
def columns_endpoint(path: str = "") -> dict[str, Any]:
    """只读列名与行数。页面靠它渲染下拉，用户还没选列时也能显示。"""
    return _guard(lambda: {"columns": service.columns_of(path), "rowCount": service.count_rows(path)})


@router.post("/merge")
def merge_endpoint(body: MergeIn) -> dict[str, Any]:
    return _guard(
        lambda: service.merge(
            body.mainPath, body.srcPath, body.mainKeys, body.srcKeys, _fill_cols(body.fillColumns)
        )
    )


@router.post("/generate")
def generate_endpoint(body: GenerateIn) -> dict[str, Any]:
    return _guard(lambda: service.generate(body.path, body.columns))


@router.post("/dedupe")
def dedupe_endpoint(body: DedupeIn) -> dict[str, Any]:
    return _guard(lambda: service.dedupe(body.path, body.keys))


@router.post("/convert")
def convert_endpoint(body: ConvertIn) -> dict[str, Any]:
    return _guard(lambda: service.convert(body.path, body.target))


@router.post("/split")
def split_endpoint(body: SplitIn) -> dict[str, Any]:
    return _guard(lambda: service.split(body.path, body.column))


@router.post("/filter")
def filter_endpoint(body: FilterIn) -> dict[str, Any]:
    return _guard(lambda: service.filter_export(body.path, body.column, body.value))


@router.post("/problem-rows")
def problem_endpoint(body: ProblemIn) -> dict[str, Any]:
    return _guard(lambda: service.problem_rows(body.path, body.keyColumn))
