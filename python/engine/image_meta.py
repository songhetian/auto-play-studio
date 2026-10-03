"""图片头解析：读出像素宽高，不依赖 Pillow。

素材库只需要知道「这张图多大」，为了这点信息引一个图像库不值得 ——
PNG / JPEG / GIF / BMP 的头部都是固定结构，直接读就行。
"""
from __future__ import annotations

import struct
from pathlib import Path

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def sniff(head: bytes) -> str:
    """按文件头判断真实格式（不信任扩展名）。"""
    if head.startswith(PNG_SIG):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if head.startswith(b"BM"):
        return "bmp"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return ""


def is_image(head: bytes) -> bool:
    return bool(sniff(head))


def size(head: bytes) -> tuple[int, int] | None:
    """从文件头读出 (宽, 高)；认不出来返回 None。"""
    kind = sniff(head)
    if kind == "png":
        # IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后
        if len(head) < 24:
            return None
        w, h = struct.unpack(">II", head[16:24])
        return int(w), int(h)

    if kind == "gif":
        if len(head) < 10:
            return None
        w, h = struct.unpack("<HH", head[6:10])
        return int(w), int(h)

    if kind == "bmp":
        if len(head) < 26:
            return None
        w, h = struct.unpack("<ii", head[18:26])
        return abs(int(w)), abs(int(h))

    if kind == "jpeg":
        return _jpeg_size(head)

    return None


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    """JPEG 没有固定偏移，得顺着段一路跳到 SOFn。"""
    i = 2  # 跳过 SOI
    n = len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:  # 无长度字段
            i += 2
            continue
        seg_len = struct.unpack(">H", data[i + 2 : i + 4])[0]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h, w = struct.unpack(">HH", data[i + 5 : i + 9])
            return int(w), int(h)
        i += 2 + seg_len
    return None


def read_size(path: str | Path) -> tuple[int, int] | None:
    """读磁盘上文件的尺寸（只读头部，几十字节）。"""
    try:
        with open(path, "rb") as f:
            head = f.read(65536)
    except OSError:
        return None
    return size(head)
