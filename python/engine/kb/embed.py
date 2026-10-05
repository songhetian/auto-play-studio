"""Embedding 适配层：把「文本 → 向量」收在一个可替换的接口后面。

## 为什么要有这层 seam

检索的核心（余弦、RRF、落库）不该依赖一个几十 MB 的模型文件才能测。
所以这里只放接口 + 一个真实实现；单测注入假 embedder，
真模型只在模型文件确实存在时才被加载。

## 缺了就退化，不要崩

模型文件、onnxruntime、tokenizers 任何一样不在，`get_embedder()` 就返回 `None`，
检索自动退回纯关键词 —— 行为与加语义之前一字不差。引擎是常驻进程，
一个**可选**能力把整个服务拖崩是最差的结果。

## 模型与入参约定

`bge-small-zh-v1.5`：中文检索小模型，512 维，量化后 ~24MB，CPU 上毫秒级。
BGE 是**非对称**检索模型：查询侧要加指令前缀、段落侧不加（加了前缀能明显
拉开相关 / 不相关）。这种「同一个模型对查询和段落编码方式不同」的差异
属于模型知识，因此封在 embedder 里 —— 对外给 `embed`（段落）与
`embed_query`（查询）两个方法，调用方不必知道前缀的存在。
"""
from __future__ import annotations

import os
import pathlib
import sys
import threading

#: BGE 查询侧指令前缀（官方推荐；段落侧不加）
QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："

#: 模型目录名
MODEL_DIRNAME = "bge-small-zh-v1.5"

#: 量化版优先（体积 / 速度），没有则退回全量
_ONNX_NAMES = ("model_quantized.onnx", "model.onnx")

#: 单条文本的最大 token 数
MAX_TOKENS = 512

_lock = threading.Lock()
_embedder: "OnnxEmbedder | None" = None
_loaded = False


class OnnxEmbedder:
    """bge-small-zh-v1.5 的 onnxruntime 实现：mean pooling + L2 归一化。

    依赖在方法内 import：没装 onnxruntime / tokenizers 时，
    这里抛的异常由 `get_embedder()` 兜住，不至于让整个语义模块 import 就失败。
    """

    def __init__(self, model_dir: str, name: str = MODEL_DIRNAME) -> None:
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self._dir = pathlib.Path(model_dir)
        self._name = name
        self._tok = Tokenizer.from_file(str(self._dir / "tokenizer.json"))
        self._tok.enable_truncation(max_length=MAX_TOKENS)
        self._tok.enable_padding()
        self._sess = ort.InferenceSession(
            str(self._onnx_path()), providers=["CPUExecutionProvider"]
        )
        self._inputs = {i.name for i in self._sess.get_inputs()}
        self._dim = 0

    def _onnx_path(self) -> pathlib.Path:
        for name in _ONNX_NAMES:
            candidate = self._dir / name
            if candidate.is_file():
                return candidate
        raise FileNotFoundError(f"{self._dir} 下没有 onnx 模型文件")

    @property
    def name(self) -> str:
        return self._name

    @property
    def dim(self) -> int:
        return self._dim

    def embed(self, texts: list[str]) -> list[list[float]]:
        import numpy as np

        if not texts:
            return []
        encs = self._tok.encode_batch(list(texts))
        ids = np.array([e.ids for e in encs], dtype=np.int64)
        mask = np.array([e.attention_mask for e in encs], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self._inputs:
            feed["token_type_ids"] = np.zeros_like(ids)

        out = self._sess.run(None, feed)[0]  # (B, T, H)
        maskf = mask[:, :, None].astype(np.float32)
        summed = (out * maskf).sum(axis=1)
        counts = np.clip(maskf.sum(axis=1), 1e-9, None)
        mean = summed / counts
        norms = np.linalg.norm(mean, axis=1, keepdims=True)
        mean = mean / np.clip(norms, 1e-9, None)
        self._dim = int(mean.shape[1])
        return mean.tolist()

    def embed_query(self, text: str) -> list[float]:
        """查询侧编码：加 BGE 指令前缀（段落侧不加，见模块 docstring）。"""
        return self.embed([QUERY_PREFIX + text])[0]


def _candidate_dirs() -> list[pathlib.Path]:
    """按优先级列出可能的模型目录。

    `AUTOPLAY_KB_MODEL_DIR` 是显式指定（打包态由 Electron 传进来）；
    其余是「模型就放在引擎旁边」的几种常见落法，覆盖开发态与
    「把模型目录拷到 exe 同级」的部署方式。
    """
    dirs: list[pathlib.Path] = []
    env = os.environ.get("AUTOPLAY_KB_MODEL_DIR")
    if env:
        dirs.append(pathlib.Path(env))
    here = pathlib.Path(__file__).resolve().parent
    dirs.append(here / "models" / MODEL_DIRNAME)
    dirs.append(pathlib.Path(sys.executable).resolve().parent / "models" / MODEL_DIRNAME)
    dirs.append(pathlib.Path.cwd() / "models" / MODEL_DIRNAME)
    return dirs


def _looks_like_model(directory: pathlib.Path) -> bool:
    return (directory / "tokenizer.json").is_file() and any(
        (directory / name).is_file() for name in _ONNX_NAMES
    )


def _disabled() -> bool:
    """`AUTOPLAY_KB_DISABLE_SEMANTIC` 置真时强制不要语义。

    测试默认开这个开关：既有那几百条用例断言的是纯关键词的行为，
    一旦模型装到本机，真实 embedding 会悄悄改变结果与耗时。
    线上也可用它给低配机留一条「关掉语义」的退路。
    """
    return os.environ.get("AUTOPLAY_KB_DISABLE_SEMANTIC", "").strip().lower() not in (
        "",
        "0",
        "false",
        "no",
    )


def get_embedder() -> "OnnxEmbedder | None":
    """可用就返回 embedder，否则 `None`（并缓存结果，不重复探盘）。"""
    global _embedder, _loaded
    if _disabled():
        return None
    with _lock:
        if _loaded:
            return _embedder
        _loaded = True
        for directory in _candidate_dirs():
            try:
                if _looks_like_model(directory):
                    _embedder = OnnxEmbedder(str(directory))
                    break
            except Exception:
                # 装了但起不来（依赖缺失 / 模型损坏）：当作没有，别拖崩引擎
                _embedder = None
        return _embedder


def reset_embedder() -> None:
    """丢掉缓存的 embedder（测试用；也用于「设置页里换了模型目录」这类场景）。"""
    global _embedder, _loaded
    with _lock:
        _embedder = None
        _loaded = False
