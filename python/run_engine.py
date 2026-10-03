"""引擎 sidecar 启动入口（PyInstaller 打包用）。

开发态由 `npm run engine`（uvicorn --app-dir python）启动；打包后由 Electron 主进程
spawn 这个脚本编出来的 exe（resources/engine/autoplay-engine.exe），最终用户无需装 Python。

端口用 AUTOPLAY_ENGINE_PORT 覆盖，默认与 electron/main.ts 的 ENGINE_PORT 一致（8731）。
"""
from __future__ import annotations

import os


def main() -> None:
    import uvicorn

    from engine.main import app

    port = int(os.environ.get("AUTOPLAY_ENGINE_PORT", "8731"))
    # 只监听回环：桌面端 sidecar，不对外暴露
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
