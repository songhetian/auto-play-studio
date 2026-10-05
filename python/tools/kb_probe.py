# -*- coding: utf-8 -*-
"""知识库召回探针 —— 决定「查知识库→填入输入框」这条路值不值得投。

为什么先跑这个：
    整条链路的生死线不是自动化，而是**检索质量**。如果客服拿真实问题去搜，
    结果里没有能直接用的答案，那么把结果自动填进输入框只是更快地给错答案。
    而这件事**零开发**就能验证 —— 下面这个脚本直接调真实的 kb 检索。

它测的是**召回**（有没有相关结果），不是**准确**（结果对不对）。
    准确要人看：它把每题的最佳结果和出处打出来，你自己判断"这条能不能用"。

用法（在**装了知识库的那台机器**上跑，读的是真实索引）：
    set AUTOPLAY_DB=%APPDATA%\\AutoPlayStudio\\autoplay.db
    python python\\tools\\kb_probe.py questions.txt
    python python\\tools\\kb_probe.py --q \"发错货了怎么办\" --top 5

questions.txt 每行一个真实问题（`#` 开头是注释）。建议 20 条以上，
最好是客服**真答不上来**的那些 —— 已经能背出来的问题测不出问题。
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.kb import service  # noqa: E402


def _excerpt(text: str, width: int = 90) -> str:
    """截一段可读的文字。命中可能落在段落中间，前后都留一点上下文。"""
    flat = " ".join(str(text or "").split())
    return flat if len(flat) <= width else flat[: width - 1] + "…"


def _load_questions(args: argparse.Namespace) -> list[str]:
    if args.q:
        return [args.q]
    if not args.file:
        raise SystemExit("用法：kb_probe.py <questions.txt>  或  kb_probe.py --q \"问题\"")
    out: list[str] = []
    with open(args.file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                out.append(line)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="知识库召回探针")
    ap.add_argument("file", nargs="?", help="问题清单（一行一个）")
    ap.add_argument("--q", help="单个问题，省得写文件")
    ap.add_argument("--top", type=int, default=3, help="每题显示前几条（默认 3）")
    args = ap.parse_args()

    questions = _load_questions(args)
    if not questions:
        raise SystemExit("问题清单是空的")

    st = service.status()
    print("=== 知识库现状 ===")
    print(f"登记文件夹：{len(st.get('folders') or [])}   文档：{st.get('fileCount')}   段落：{st.get('docCount')}")
    idx = st.get("indexing") or {}
    if idx.get("running"):
        print(f"⚠ 索引还在跑（{idx.get('done')}/{idx.get('total')}）—— 现在测出来的召回会偏低，建议等它跑完")
    if st.get("failed"):
        print(f"⚠ 有 {st['failed']} 个文件索引失败 —— 这些文件的内容搜不到，先看它们")
    print(f"语义那一路：{'已启用（BM25 + 向量混合）' if st.get('semanticEnabled') else '未启用（只有关键词路）'}")
    if not st.get("semanticEnabled"):
        print("  → 只有关键词路时，同义/换一种说法的提问基本搜不到；下面的召回率要按这个标准看")

    print("\n=== 逐题召回 ===")
    missed: list[str] = []
    hit_count = 0
    for i, q in enumerate(questions, 1):
        res = service.search(q, limit=args.top)
        results = res.get("results") or []
        if results:
            hit_count += 1
        else:
            missed.append(q)
        print(f"\n[{i}] {q}")
        if not results:
            print("    ✘ 0 条 —— 库里没有能召回的内容")
            continue
        print(f"    ✔ {res.get('count')} 条")
        for r in results:
            path = r.get("path") or "(未知文件)"
            name = os.path.basename(path)
            line = r.get("line")
            via = r.get("matchedBy") or r.get("matched_by") or ""
            where = f"{name}:{line}" if line else name
            print(f"      · [{where}] {via:<8} {_excerpt(r.get('text'))}")

    total = len(questions)
    print("\n=== 汇总 ===")
    print(f"有召回 {hit_count}/{total}（{hit_count * 100 // max(total, 1)}%）   零召回 {len(missed)}")
    if missed:
        print("\n零召回的题目（这些是知识库的空缺，不是检索的错）：")
        for q in missed:
            print(f"  - {q}")
    if hit_count == 0:
        print("\n结论：知识库基本是空的。先整理内容，再谈自动填入。")
    elif hit_count * 2 <= total:
        print("\n结论：召回率偏低。优先补内容（把客服答不上来的问题对应的答案写进去），"
              "而不是先做自动化 —— 检索不准，自动化只会更快地给错答案。")
    else:
        print("\n结论：召回率可用。往下做「热键 → 检索 → 填入输入框（不发送）」是划算的。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
