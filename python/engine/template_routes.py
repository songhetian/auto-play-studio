"""模板校验的 HTTP 路由。

只做三件事：校验入参、读真表头、把问题摊平成前端能定位的结构。
判定逻辑全在 `engine.template` 里（`template_issues`），与运行时渲染共用同一个解析出口。

为什么要有这个接口（前端已经有一份同语义的纯函数了）：
前端手上只有上传时探测到的列名缓存，**用户把 Excel 换掉之后缓存就不作数了**。
保存前拿真实文件再校一遍，才能挡住「列名改了、模板没改」这种最典型的翻车。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import excel, template

router = APIRouter(prefix="/template", tags=["template"])


class CheckPayload(BaseModel):
    excelPath: str
    templates: list[str] = []


@router.post("/check")
def check(payload: CheckPayload) -> dict:
    """拿真实表头校验一批模板。issues 里带 index，前端据此定位到具体哪条指令。"""
    try:
        columns = excel.detect_columns(payload.excelPath)
    except Exception as exc:  # noqa: BLE001  读不了的文件（删了/格式不对）都是入参问题
        raise HTTPException(400, f"读不出「{payload.excelPath}」的表头：{exc}") from exc

    return {
        "columns": columns,
        "issues": [
            {"index": index, "template": text, "message": message}
            for index, text in enumerate(payload.templates)
            for message in template.template_issues(text, columns)
        ],
    }
