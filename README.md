# AutoPlay Studio

桌面自动化综合工具包。架构为 **控制台（Launcher）+ 独立实例**：每个工具可多开，实例之间完全隔离、并行运行。

- 前端：Electron + React + React Router + React Query + Zustand + Zod + ECharts
- 引擎：Python（FastAPI + SQLite + openpyxl）
- 原型与方案：`designs/auto-play-toolkit/`（`页面设计 v5.html`、`设计方案.md`）

## 目录

```
electron/            主进程：实例窗口管理、进程枚举、全局热键、区域框选、拉起引擎
  main.ts
  preload.ts
  region.html          全屏遮罩：拖拽框选截图区域
  region-preload.ts    遮罩窗口专用桥
src/                 渲染进程
  app/moduleRegistry.ts   工具箱注册表（新增工具加一行）
  modules/console/         控制台：工具箱 + 实例管理
  modules/instance/        实例配置页 / 运行详情页
  modules/assets/          图像素材库：选图器 + 管理页
  lib/assetFilter.ts       素材筛选（纯逻辑，单独可测）
  stores/instanceStore.ts  Zustand + 状态机守卫
  schemas/instance.ts      Zod：配置、指令、行状态、状态机
  lib/api.ts               引擎 REST + 日志 WebSocket
python/engine/       自动化引擎
  db.py        SQLite（WAL）存储，见 docs/adr/0001
  excel.py     列检测、状态回写、跳过成功行、物流写入新文件
  providers.py 物流查询 Provider（Excel 合并 / 网页自动化 / 接口）
  runner.py    每实例独立 worker 线程 + 状态机
  commands.py  RPA 指令解释器（指令 → 对驱动的调用，含 {列名} 变量替换）
  driver.py    驱动协议 + 唯一决定用哪个实现的 build_driver()
  pyautogui_driver.py  真实驱动（pyautogui + OpenCV，依赖全部延迟导入）
  window_control.py    按标题激活窗口（纯 ctypes，无三方依赖）
  image_meta.py        图片头解析取宽高（纯 stdlib，不引 Pillow）
  image_library.py     素材库：文件按 id 落盘 + 元数据入库
  image_refs.py        引用关系：谁在用、删前拦截、体检
  screen_capture.py    区域截图采集（采集原语可注入，便于测试）
  image_routes.py      素材库 HTTP 路由
  main.py      FastAPI（挂载在 /api）+ WS 日志
  compare/     Excel 多表对比（按职责拆开，每块可单独替换）
    excel_io.py     读表 + 表头规整
    column_match.py 列名智能匹配（「订单号」↔「订单编号」）
    compare_core.py 对比引擎（纯逻辑，不碰 IO）
    report.py       报告写出（汇总 + 对比结果，带配色）
    config_io.py    方案存取（按文件名复用映射）
    service.py      门面：读表 → 匹配 → 对比 → 写报告
    routes.py       HTTP 路由（只做校验与落库）
docs/adr/      架构决策记录
```

## 图像素材库

图像指令（`image.assetId`）指向素材库里的素材，而不是内嵌图片字节 —— 这样一张图被多少条指令用、改一次全都生效，也才能在删除前问一句「谁在用」。

素材两层存：磁盘按 `id` 命名（`AUTOPLAY_ASSETS_DIR`，默认库文件旁的 `image_assets/`），数据库 `image_assets` 表存展示名、尺寸、阈值、标签。展示名可以随便改，文件名不会跟着变，规避中文路径与重名问题。

三个约定：

1. **删素材默认拦住。** 被指令引用时 `DELETE /api/images/{id}` 返回 409 + 引用清单（实例名 + 第几条指令），前端弹确认框；`?force=true` 才真删，并把那些指令里的 `assetId` 清空（其余参数保留，重新选张图就能用）。清引用只发生在唯一的删除路径里，不会留下指向空气的 id。
2. **阈值有两个作用域。** 素材上的阈值是「导入时定的推荐值」，指令上的阈值才是这条指令实际用的。选图不会偷偷改指令阈值，只在面板上给一个「用素材推荐值 0.92」按钮。
3. **体检。** `GET /api/images/audit` 报出「引用了不存在的素材」和「素材文件丢了」两类问题 —— 配好之后就该能查出来，而不是执行到那一条才报错。

区域框选走 Electron 全屏遮罩（`region.html`）：遮罩铺在目标显示器上按 DIP 取坐标，主进程乘该屏 `scaleFactor` 换成物理像素再交给 Python（`pyautogui` / PIL 都是物理像素）。多屏且各屏缩放不同时该换算不精确，属设备层，需真机验收。

## 运行

```bash
# 1) 前端依赖
npm install

# 2) 引擎依赖
pip install -r python/requirements.txt

# 3) 启动引擎（:8731）
npm run engine          # python -m uvicorn engine.main:app --app-dir python --port 8731

# 4) 开发模式：Vite（:5173，已代理 /api 与 /ws）+ Electron
npm run dev
npm run dev:electron    # 会先编译 electron/*.ts 到 dist-electron/
```

测试：`npm test`（vitest，前端 54 项）、`npm run test:py`（pytest，172 项）。
`npm run typecheck` 同时检查渲染进程与主进程。

打包：`npm run build`（electron-builder；引擎建议用 PyInstaller 打成 sidecar 随包分发）。

## 测试

```bash
npm test          # 前端：vitest（schema 校验 + store 状态机）
npm run test:py   # 引擎：pytest（Excel 回写 / Runner 跳过 / 物流合并 / 状态机 / API）
npm run typecheck # tsc --noEmit
```

后端按 seam 组织：`python/tests/` 下每个文件对应一条接缝
（excel / runner / providers / state_machine / api / compare_column_match / compare_core / compare_report / compare_config / compare_api）。
测试通过环境变量 `AUTOPLAY_DB` 指向固定的 `python/test_autoplay.db`（每会话清表），不会碰到开发库。

## 当前已落地

- 控制台：工具箱（自动化脚本助手 / 桌面图片监控 / 物流信息查询）+ 实例管理（状态、进度、复制、删除、打开独立窗口）
- 实例配置页：Excel **拖拽上传** + 列映射（客户名称列＝搜索关键词 / 消息内容列 / 状态列留空自动创建）+ 统一发送内容 + 执行策略（跳过成功行、回写失败原因、备份）；流程编排（指令库 / 可拖拽排序画布 / 属性面板）
- 物流工具：上传 → 自动检测列 → 选物流单号列 → 查询方式（① Excel 匹配合并 / ② 网页自动化 / ③ 接口预留）→ 写入新文件
  - **② 网页自动化（Provider）**：抓页动作抽成可注入的 `LogiScraper`，生产用 `PlaywrightScraper`（打开站点、填单号、点查询、读结果，浏览器依赖延迟导入），测试注入 `FakeScraper`；站点适配器（url/input/button/result/status/trace 选择器）在配置页可填；撞到验证码（`detect_captcha`）抛 `CaptchaEncountered`，runner 按 `pauseOnCaptcha` 暂停转人工。结果走 `waybill_cache` 不重复查。
- **Excel 多表对比**（移植自 `compare-excel/`，UI 用 React 重写）：
  上传 A 表（基准）→ 自动猜字段类型 → 指定主键/对比角色 → 追加 B/C 表并**自动匹配列名**（可手动纠正）
  → 设容差 → 执行 → 结果落库 + 生成报告 xlsx（『汇总』+『对比结果』带配色）；支持保存方案复用
- 运行详情页：状态机控制 + 进度 + ECharts（结果分布 / 每行耗时）+ 执行明细 + 日志流
- 引擎：SQLite（WAL）存储、Excel 状态回写、跳过成功行、物流 Provider 抽象、每实例独立 worker
- **崩溃恢复**：引擎启动时自动对账，把残留的 `running`/`paused`/`stopping`/`starting` 复位为 `idle` 并保留已完成进度（`progress_done/total`）；`GET /api/instances/recovery` 暴露启动那次恢复明细，控制台据此展示「已恢复 N 个被中断实例」
- **RPA 指令执行链路已接通**：整行 Excel 数据 → `{列名}` 变量替换 → 指令解释器 → 驱动
  （窗口激活 / 输入文本 / 按键组合 / 图像匹配点击 / 延时）。统一发送内容开启后整批行发同一句。

### 指令执行的安全约定

- **占位符解析不出来就整行失败**，绝不把 `{客户名}` 这种字面量发给客户；
- 某条指令失败立即中止本行，不带着错误状态继续点下去；
- 找不到窗口 / 找不到图片 → 该行失败并写明原因（或按配置重试一轮），而不是乱点；
- 真实驱动缺依赖时报「请执行 pip install xxx」，不会静默失败。

## TDD 阶段修掉的真实缺陷

1. **多实例并发写库会崩**：所有线程共用一条 SQLite 连接，并发时抛
   `InterfaceError: bad parameter or other API misuse`。改为每线程一条连接 + 全局写锁串行化。
2. **自定义状态列时「跳过成功行」失效**：`read_rows` 硬编码只读「执行状态」列。
3. **空状态被读成字符串 `"None"`**。
4. **上传 Excel 与复制实例的接口从来没生效**：`POST /instances/{iid}/{action}` 把
   `/excel`、`/clone` 当作动作名吞掉了。控制接口改为 `/instances/{iid}/control/{action}`。
5. **上传后默认行区间是 1~1**，而数据从第 2 行起 —— 直接点「开始」一行都不跑。
   现在按真实行数设置区间，并返回真实行数（原来硬编码 0）。
6. **物流单号带空格永远匹配不上**：新增 `normalize_no` 归一化。
7. **缺对照表时抛 `KeyError`**（接口 500）：改为可理解的 `ValueError`。
8. **改一列配置就把流程指令抹掉**：`patchConfig` 原来是浅合并，改为工具层深合并。
9. **指令参数缺失只有执行时才暴露**：Zod 增加跨字段校验（按键必须有按键、图像必须选图、
   结束行不能小于起始行）。
10. **对比报告写超过 Z 列就崩**：原 `chr(ord("B") + i)` 到第 26 列以后会写出错误的列宽，
    改为真正的列号→列字母换算。
11. **对比方案换文件后仍套用旧容差**：主表名对不上时容差却生效，阈值就是错的。
    现在整套方案（含容差）只在主表匹配时生效。
12. **运行器只拿到主键值**：`read_rows` 不返回整行数据，导致指令里的 `{客户名称}` 取不到、
    「消息内容列」根本发不出去。现在每行带完整 `values`（状态列除外）。
13. **流程编排的属性面板是纯占位**：所有输入框都是 `defaultValue` 且没有 onChange，
    指令参数永远存不进去 —— 解释器再对用户也配不了。已接上 store（新增 `patchCmd`）。
14. **新建按键/图像指令必然保存失败**：`addCmd` 不填必填参数，一保存就被 Zod 拦下。
    现在新指令直接带上可用默认值。

## 关于 compare-excel/

那是 Excel 对比功能的原始 PyQt 版本，**逻辑已移植**到 `python/engine/compare/`，
界面用 React 重写成工具箱里的第 4 个工具。原目录仅作参考保留，`main_window.py` / `theme.py`
（PyQt 界面）不再维护；确认无用后可整目录删除。

## 下一步（按优先级）

- [x] 图像库落地：`image_assets` 表 + 截图/导入/阈值编辑 + 引用同步（已完成）
- [x] 崩溃恢复：实例状态与进度落盘 + 启动自动恢复（已完成，详见上节）
- [x] 物流 Provider ②：Playwright 网页自动化 + 站点适配器 + 验证码暂停（已完成；PlaywrightScraper 依赖浏览器/网络，属设备层只人工验收）
- [ ] 安全护栏：执行前确认、发送频率限制、敏感操作二次确认
- [ ] 真机验收：pyautogui / OpenCV 那段只能在有桌面的环境人工跑一遍
