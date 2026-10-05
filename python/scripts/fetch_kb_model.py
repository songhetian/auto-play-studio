"""拉取知识库语义检索要用的 bge-small-zh-v1.5 模型资产。

引擎是**每台机器本地的 sidecar**，所以每台装了引擎的机器都得有这份模型；
但它是 24MB 二进制，不进仓库，用这个脚本按需拉。

默认走 hf-mirror.com（国内可达），失败再退回 huggingface.co。
引擎在 `engine/kb/embed.py` 里按同一套目录约定找模型。

用法：
    python python/scripts/fetch_kb_model.py            # 缺什么拉什么
    python python/scripts/fetch_kb_model.py --force    # 重下
目标目录也可用环境变量 AUTOPLAY_KB_MODEL_DIR 覆盖。
"""
from __future__ import annotations

import argparse
import os
import pathlib
import sys
import urllib.request

MODEL_DIRNAME = "bge-small-zh-v1.5"

#: (目标文件名, [候选 URL]，按顺序试)
FILES: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "tokenizer.json",
        (
            "https://hf-mirror.com/BAAI/bge-small-zh-v1.5/resolve/main/tokenizer.json",
            "https://huggingface.co/BAAI/bge-small-zh-v1.5/resolve/main/tokenizer.json",
        ),
    ),
    (
        "model_quantized.onnx",
        (
            "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx",
            "https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx",
        ),
    ),
)

#: 小于这个字节数基本就是错误页而不是模型
_MIN_BYTES = 100_000


def default_dir() -> pathlib.Path:
    env = os.environ.get("AUTOPLAY_KB_MODEL_DIR")
    if env:
        return pathlib.Path(env)
    python_root = pathlib.Path(__file__).resolve().parents[1]  # python/
    return python_root / "engine" / "kb" / "models" / MODEL_DIRNAME


def _download(urls: tuple[str, ...], dest: pathlib.Path) -> None:
    last: Exception | None = None
    for url in urls:
        tmp = dest.with_suffix(dest.suffix + ".part")
        try:
            print(f"  <- {url}")
            with urllib.request.urlopen(url, timeout=60) as resp, open(tmp, "wb") as f:
                while chunk := resp.read(1 << 20):
                    f.write(chunk)
            size = tmp.stat().st_size
            if size < _MIN_BYTES:
                raise RuntimeError(f"下载内容过小（{size} 字节），可能是错误页")
            tmp.replace(dest)  # 下全了才落最终文件名，避免半截文件被引擎当成模型
            print(f"  OK {dest.name}（{size // 1024} KB）")
            return
        except Exception as exc:  # noqa: BLE001 —— 逐个镜像重试，最后统一报错
            last = exc
            tmp.unlink(missing_ok=True)
            print(f"  x 失败：{exc}")
    raise SystemExit(f"{dest.name} 下载失败：{last}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="拉取 bge-small-zh-v1.5 模型资产")
    parser.add_argument("--dir", default=str(default_dir()), help="目标目录")
    parser.add_argument("--force", action="store_true", help="已存在也重下")
    args = parser.parse_args(argv)

    target = pathlib.Path(args.dir)
    target.mkdir(parents=True, exist_ok=True)
    print(f"模型目录：{target}")

    for name, urls in FILES:
        dest = target / name
        if dest.is_file() and not args.force:
            print(f"  - {name} 已存在，跳过")
            continue
        _download(urls, dest)

    print("完成。引擎下次启动时会自动加载；没有它则退回纯关键词检索。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
