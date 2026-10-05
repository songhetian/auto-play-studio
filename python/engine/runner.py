"""实例运行器：每个实例一个独立 worker 线程，状态机 + 结果回写。

状态机（与前端 ALLOWED_TRANSITIONS 一致）：
    idle → starting → running ⇄ paused → stopping → completed / error / idle
"""
from __future__ import annotations

import os
import threading
import time
from typing import Callable

from . import db
from . import excel
from .commands import run_commands
from .driver import Driver, DriverUnavailable, build_driver
from .notify.report import report_hit
from .text_grabber import build_grabber
from .providers import CaptchaEncountered, LogisticsProvider, build_provider
from . import screen_lock
from .screen_lock import ScreenBusy

ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "idle": {"starting", "armed", "error"},
    "starting": {"running", "error", "idle"},
    "running": {"paused", "stopping", "completed", "error"},
    "paused": {"running", "stopping", "error"},
    "stopping": {"idle", "error"},
    "completed": {"idle"},
    "error": {"idle", "starting"},
    "armed": {"idle", "error"},
}


#: 一行的执行结果：(是否成功, 说明/失败原因)
RowExecutor = Callable[[dict, dict], "tuple[bool, str]"]

#: 宏没有数据源，指令里能引用的「当前行」是空的。
#: 写了 `{列名}` 会当场报「没有这一列」而不是把占位符原样打出去 —— 那是模板层的既定行为。
_EMPTY_ROW: dict = {"row_no": 0, "key": "", "values": {}}

#: 指令没起名字时，台账里用类型兜底 —— 空白的名字比「输文本」更难认
_CMD_TYPE_LABEL = {"text": "输入文本", "key": "按键", "img": "图像", "flow": "延时", "win": "切换窗口"}


def _asset_name(asset_id: str) -> str:
    """通知标题用素材名，不是素材 id —— 「img_a3f1 命中了」对人没有意义。

    素材已被删掉（或读库失败）就退回 id：标题宁可丑，也不能空。
    """
    try:
        from .image_library import get_image

        rec = get_image(asset_id)
    except Exception:  # noqa: BLE001
        return asset_id
    return (rec or {}).get("name") or asset_id


def _cmd_label(cmd: dict) -> str:
    name = str(cmd.get("t") or "").strip()
    return name or _CMD_TYPE_LABEL.get(str(cmd.get("type")), "指令")


class InstanceRunner:
    def __init__(
        self,
        instance_id: str,
        on_log: Callable[[str], None] | None = None,
        executor: RowExecutor | None = None,
        driver: Driver | None = None,
        provider: LogisticsProvider | None = None,
        monitor_engine: "MonitorEngine | None" = None,
    ) -> None:
        self.id = instance_id
        self._thread: threading.Thread | None = None
        self._pause = threading.Event()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self.on_log = on_log or (lambda m: None)
        # 执行内核可替换：默认是真实自动化内核，测试注入假内核
        self._executor: RowExecutor = executor or self._execute_commands
        # 驱动按需构造：真驱动要 import pyautogui，测试注入假驱动
        self._driver = driver
        # 物流 Provider 可替换：默认按配置构建，测试注入报验证码的假 Provider
        self._provider = provider
        # 监控内核可替换：默认按配置构建（复用 notic 检测内核），测试注入假内核
        self._monitor_engine = monitor_engine

    # ── 状态 ──
    def status(self) -> str:
        r = db.query("SELECT status FROM instances WHERE id=?", (self.id,))
        return r[0]["status"] if r else "idle"

    def _set_status(self, next_status: str) -> bool:
        """状态转换：**读与写必须在同一个事务里**。

        曾经先 `status()` 读一次、再单独开事务写（两段中间隔着一个窗口）：
        停实例时，worker 线程可能已经把状态推到 idle 了，主线程手里那张旧快照还写着 running，
        于是把「running → stopping」这个当时已非法的转换又写了一遍 ——
        实例就永远停在「停止中」，而 stopping 只允许去 idle / error，界面再也点不动。

        所以这里用**写事务里那条连接**读当前状态：写入是全局串行的，
        拿到写锁之后读到的必然是所有已提交的写入。
        """
        with db.write() as c:
            r = c.execute("SELECT status FROM instances WHERE id=?", (self.id,)).fetchone()
            cur = r["status"] if r else "idle"
            if next_status not in ALLOWED_TRANSITIONS.get(cur, set()):
                return False
            c.execute(
                "UPDATE instances SET status=?, updated_at=datetime('now','localtime') WHERE id=?",
                (next_status, self.id),
            )
        return True

    # ── 控制 ──
    def start(self) -> bool:
        # 终态自动复位：跑完/出错后再点「开始」应能直接重跑，而不是要求用户先重置
        if self.status() in ("completed", "error"):
            self._set_status("idle")

        # 碰屏互斥：rpa/macro 要动真键鼠，一块屏幕同一时刻只能有一个在跑。
        # 抢不到就抛 ScreenBusy，调用方拿得到「被谁占着」。
        #
        # 顺序很关键：**先做状态转换（原子），成功了再抢锁**。
        # 反过来（先抢锁再转状态）在「同一实例重复点开始」时会出事：
        # 状态还是 running、转 starting 失败 → 走到失败分支把锁 release 掉，
        # 而锁正是这个**正在跑**的实例握着的 —— 另一个 rpa 实例立刻能抢进来，
        # 两个实例同时动键鼠。所以失败路径只在「确实是新起的这一轮」才需要退锁。
        holds_screen = screen_lock.is_screen_tool(self._tool())
        if not self._set_status("starting"):
            return False
        if holds_screen:
            try:
                screen_lock.acquire_or_raise(self.id)
            except ScreenBusy:
                # 抢不到：把状态退回 idle，让用户能原样重试（start 前只会是 idle/error）
                self._set_status("idle")
                raise

        self._pause.clear()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return True

    def _tool(self) -> str | None:
        cfg = db.get_config(self.id) or {}
        return cfg.get("tool")

    def pause(self) -> bool:
        if self.status() != "running":
            return False
        self._pause.set()
        return self._set_status("paused")

    def resume(self) -> bool:
        if self.status() != "paused":
            return False
        self._pause.clear()
        return self._set_status("running")

    def stop(self) -> bool:
        self._stop.set()
        self._pause.clear()
        return self._set_status("stopping")

    # ── 执行 ──
    def _run(self) -> None:
        cfg = db.get_config(self.id)
        # 屏幕锁在 start() 里握上、在这里放开：无论这一轮怎么退场（跑完/出错/停止），
        # 屏幕都要交出来，否则下一个实例会永远抢不到。
        holds_screen = screen_lock.is_screen_tool(cfg.get("tool"))
        try:
            self._set_status("running")
            # 每轮开始先把进度清零。有的轮次会在真正动手之前就退场（绑定的窗口找不到、
            # 宏里还没有指令）—— 不清零的话，页面上会留着**上一轮**的数字：
            # 「5 / 5 条指令」配 0 条明细和一个错误状态，读起来像「都成了，只是没显示」。
            with db.write() as c:
                c.execute("UPDATE instances SET progress_done=0, progress_total=0 WHERE id=?", (self.id,))
            # 只有「一次性任务」会回报没走完（目前是 macro）：断在中途就不算完成
            failed = False
            if cfg.get("tool") == "rpa":
                self._run_rpa(cfg)
            elif cfg.get("tool") == "logi":
                self._run_logi(cfg)
            elif cfg.get("tool") == "cmp":
                self._run_cmp(cfg)
            elif cfg.get("tool") == "monitor":
                self._run_monitor(cfg)
            elif cfg.get("tool") == "guard":
                self._run_guard(cfg)
            elif cfg.get("tool") == "macro":
                failed = not self._run_macro(cfg)
            else:
                self.on_log("该工具尚无执行器")
            if self._stop.is_set():
                self._set_status("stopping")
                self._set_status("idle")
            elif failed:
                # 宏断在第 2 条却顶着「已完成」，客服会读成「这条回复发出去了」
                self._set_status("error")
            else:
                self._set_status("completed")
        except Exception as exc:  # noqa: BLE001
            db.log(self.id, f"执行异常：{exc}", "error")
            self.on_log(f"执行异常：{exc}")
            with db.write() as c:
                c.execute("UPDATE instances SET status='error' WHERE id=?", (self.id,))
        finally:
            if holds_screen:
                screen_lock.release(self.id)

    def _wait_gate(self) -> bool:
        """遇到暂停就阻塞，遇到停止返回 False。"""
        while self._pause.is_set() and not self._stop.is_set():
            time.sleep(0.2)
        return not self._stop.is_set()

    def _run_rpa(self, cfg: dict) -> None:
        rpa = cfg["rpa"]
        path = rpa["excelPath"]
        if rpa.get("backup"):
            excel.backup_file(path)

        status_col = rpa.get("colStatus") or excel.STATUS_COLUMN_DEFAULT
        excel.ensure_status_column(path, status_col)

        rows = excel.read_rows(
            path, rpa["colName"], int(rpa.get("from", 1)), int(rpa.get("to", 1)), status_col
        )
        with db.write() as c:
            c.execute("UPDATE instances SET progress_total=? WHERE id=?", (len(rows), self.id))
            c.execute("INSERT INTO runs(instance_id, status) VALUES (?, 'running')", (self.id,))
            run_id = c.execute("SELECT last_insert_rowid()").fetchone()[0]

        self._activate_bound_window(cfg)

        done = 0
        # 每行之间的节流间隔：防止向目标窗口发送过快被风控/限流。
        # 默认 500ms（见 DEFAULT_CONFIG / rpaConfigSchema）；配置缺失时回落到 0（不节流）。
        interval_s = max(0, int(rpa.get("sendIntervalMs", 500))) / 1000.0
        for r in rows:
            if not self._wait_gate():
                break
            # 跳过已「成功」的行
            if rpa.get("skipSuccess", True) and r["existing_status"] == excel.STATUS_OK:
                self._record(run_id, r["row_no"], r["key"], "skip", "上次已成功", 0)
                done += 1
                continue

            t0 = time.time()
            ok, msg = self._executor(cfg, r)
            duration = int((time.time() - t0) * 1000)
            status = "ok" if ok else "err"
            excel.write_row_status(
                path,
                r["row_no"],
                excel.STATUS_OK if ok else excel.STATUS_ERR,
                "" if ok else (msg if rpa.get("writeReason", True) else ""),
                status_col,
            )
            self._record(run_id, r["row_no"], r["key"], status, msg, duration)
            done += 1
            with db.write() as c:
                c.execute("UPDATE instances SET progress_done=? WHERE id=?", (done, self.id))
            self.on_log(f"行 {r['row_no']}「{r['key']}」{'成功' if ok else '失败：' + msg}")
            # 末行之后无需等待；仅行与行之间节流。
            if interval_s and done < len(rows):
                time.sleep(interval_s)

    def _activate_bound_window(self, cfg: dict) -> None:
        """把「绑定窗口」切到前台，一轮只做一次。

        这个字段以前是**只有前端在读、而且拿来拦住保存**的死字段：配置页写着
        「运行时会先激活这个窗口再执行指令」，引擎侧却从来没人读它 ——
        用户被迫选一个窗口，选完毫无作用。现在把承诺接上。

        找不到窗口就抛 `DriverUnavailable` 让整轮失败：继续跑等于往「此刻恰好在前台」
        的那个窗口里打字，客服场景下那可能就是把这批话术发给了别的客户。
        存档里 window 为空（手工改过 / 更早的版本）则跳过，不因此让人跑不起来。
        """
        title = str(cfg.get("window") or "").strip()
        if not title:
            return
        self.driver().activate_window(title)
        self.on_log(f"已激活窗口「{title}」")

    def _run_macro(self, cfg: dict) -> bool:
        """按键精灵：按顺序把指令序列走一遍，一轮只走一遍。

        与 rpa 的根本区别是**没有数据源** —— 不读 Excel、没有行、不回写任何表。
        客服日常大量动作本来就没有「一批数据」（截个图、复制一段、切个标签页），
        硬塞进 rpa 会让「有一张表 + 逐行 + 回写状态」之外多出第二种语义。

        指令复用 rpa 那套 `Cmd`（`text` / `key` / `img` / `flow` / `win`），
        解释器也共用，所以组合键、模板、失败原因这些行为两边完全一致。

        返回**整轮是否走完**：宏是一次性动作，断在中途就没完成，
        调用方据此把实例置为 `error`，而不是让它顶着「已完成」蒙混过去。
        """
        macro = cfg.get("macro") or {}
        cmds = macro.get("cmds") or []

        # 没绑窗口就直接不跑。宏的全部意义是「在某个窗口里按几下」，没有目标窗口
        # 就等于往「此刻恰好在前台」的那个窗口里打字 —— 客服场景下那可能就是
        # 这批话术发给了别的客户。配置页会拦住这种存档，手工改过的 JSON 拦不住，
        # 所以引擎自己认这条底线（`_activate_bound_window` 对 rpa 的「空则跳过」
        # 是有意为之的历史兼容，宏没有历史包袱，就不必跟着放宽）。
        if not str(cfg.get("window") or "").strip():
            self.on_log("这个宏还没有绑定窗口，先选一个目标窗口 —— 没窗口就不知道该往哪儿按键")
            return False

        if not cmds:
            self.on_log("这个宏里还没有指令，先去配置页加几条再执行")
            return False

        with db.write() as c:
            c.execute("UPDATE instances SET progress_total=? WHERE id=?", (len(cmds), self.id))
            c.execute("INSERT INTO runs(instance_id, status) VALUES (?, 'running')", (self.id,))
            run_id = c.execute("SELECT last_insert_rowid()").fetchone()[0]

        self._activate_bound_window(cfg)

        done = 0
        for i, cmd in enumerate(cmds, start=1):
            if not self._wait_gate():
                break
            label = _cmd_label(cmd)
            if cmd.get("on", True):
                t0 = time.time()
                ok, msg = run_commands([cmd], _EMPTY_ROW, self.driver())
                self._record(run_id, i, label, "ok" if ok else "err", msg, int((time.time() - t0) * 1000))
                self.on_log(f"第 {i} 步「{label}」{'完成' if ok else f'失败：{msg}，已停下'}")
            else:
                # 关掉的指令也占一行：少了它进度条永远差一格，用户也看不出少的是谁
                self._record(run_id, i, label, "skip", "已关闭", 0)
                ok = True
            done += 1
            with db.write() as c:
                c.execute("UPDATE instances SET progress_done=? WHERE id=?", (done, self.id))
            if not ok:
                return False
        return True

    def _execute_commands(self, cfg: dict, row: dict) -> tuple[bool, str]:
        """按 cfg['rpa']['cmds'] 逐条执行；真正的翻译在 commands.py 里。"""
        rpa = cfg["rpa"]
        row = self._apply_unified_text(rpa, row)
        try:
            return run_commands(rpa.get("cmds", []), row, self.driver())
        except DriverUnavailable as exc:
            raise RuntimeError(str(exc)) from exc

    def driver(self) -> Driver:
        if self._driver is None:
            self._driver = build_driver()
        return self._driver

    @staticmethod
    def _apply_unified_text(rpa: dict, row: dict) -> dict:
        """统一发送内容：开启后忽略 Excel 的消息内容列，整批行都发同一句。"""
        col = rpa.get("colMsg")
        if not (rpa.get("unified") and col):
            return row
        values = dict(row.get("values") or {})
        values[col] = rpa.get("unifiedText", "")
        return {**row, "values": values}

    def _run_logi(self, cfg: dict) -> None:
        logi = cfg["logi"]
        provider = self._provider or build_provider(logi)
        numbers = self._read_waybills(logi)
        with db.write() as c:
            c.execute("UPDATE instances SET progress_total=? WHERE id=?", (len(numbers), self.id))
            c.execute("INSERT INTO runs(instance_id, status) VALUES (?, 'running')", (self.id,))
            run_id = c.execute("SELECT last_insert_rowid()").fetchone()[0]

        results: list[dict[str, str]] = []
        for i, no in enumerate(numbers, start=1):
            if not self._wait_gate():
                break
            t0 = time.time()
            try:
                r = provider.query(no)
                results.append(r.as_dict())
                status, msg = ("ok", r.status) if r.status != "无轨迹" else ("err", "无轨迹")
            except CaptchaEncountered:
                # 项目约定：遇验证码暂停转人工（受 pauseOnCaptcha 控制）
                status, msg = "err", "检测到验证码，已暂停转人工"
                if logi.get("pauseOnCaptcha"):
                    self.pause()
            except Exception as exc:  # noqa: BLE001
                status, msg = "err", str(exc)
            self._record(run_id, i, no, status, msg, int((time.time() - t0) * 1000))
            with db.write() as c:
                c.execute("UPDATE instances SET progress_done=? WHERE id=?", (i, self.id))
            self.on_log(f"{no} · {msg}")
            if logi.get("provider") == "web":
                time.sleep(max(0.8, logi.get("intervalMs", 1500) / 1000))

        out = excel.write_logistics_result(logi["file"], results, logi["colWaybill"])
        self.on_log(f"已写入新文件：{out}")

    def _run_cmp(self, cfg: dict) -> None:
        """Excel 对比：一次性任务 —— 读表 → 比对 → 写报告 → 结果落库。"""
        from .compare import routes as compare_routes

        cmp_cfg = cfg["cmp"]
        report = compare_routes._execute(cmp_cfg)

        out = compare_routes._report_path(self.id)
        from .compare import service

        service.write(out, report, os.path.basename(cmp_cfg["primaryFile"]), cmp_cfg.get("tolerance", 0.0))
        compare_routes.save_report_json(self.id, report)
        cmp_cfg["outFile"] = out
        db.save_config(self.id, cfg)

        compare_routes._persist(self.id, report)
        self.on_log(
            f"对比完成：一致 {report['summary'].get('ok', 0)} / 不一致 {report['summary'].get('diff', 0)} / "
            f"缺失 {report['summary'].get('missing', 0)} / 多余 {report['summary'].get('extra', 0)} / "
            f"错误 {report['summary'].get('error', 0)}"
        )
        self.on_log(f"报告已生成：{out}")

    def _run_monitor(self, cfg: dict) -> None:
        """桌面图片监控：持续轮询屏幕，命中规则里的目标图即落日志/运行详情。

        复用 notic 的 OpenCV 模板匹配内核（monitor.MonitorEngine）。pause/stop 由状态机
        驱动，与 rpa/logi/cmp 一致；命中通过 db.log 写入运行详情，声音/弹窗归设备层后续接入。
        """
        from .monitor import build_monitor, make_alert

        # 本轮的命中快照：asset_id → 相对素材库根目录的路径。
        # 存图成功时引擎通过 on_snapshot 回调塞进来，report_hit 时取用；
        # 存不下就没有这一项，命中照记 —— 存图是附加能力，不能卡住监控。
        shots: dict[str, str] = {}

        def _take_snapshot(asset_id: str, rel: str) -> None:
            shots[asset_id] = rel

        # 声音告警是设备层钩子（仅真机验收）；测试注入的 engine 走自己的路径
        engine = self._monitor_engine or build_monitor(
            cfg,
            on_hit=make_alert(cfg),
            on_snapshot=_take_snapshot,
            on_log=self.on_log,
            instance_id=self.id,
        )
        # 进度：规则数作可视化总量，每命中一条 +1（仅展示用，不影响监控逻辑）
        with db.write() as c:
            c.execute("UPDATE instances SET progress_total=? WHERE id=?", (len(engine.zones), self.id))
        done = 0
        try:
            while not self._stop.is_set():
                if not self._wait_gate():
                    break
                shots.clear()  # 每轮重来：上轮的快照不能配到这轮的命中上
                try:
                    hits = engine.poll_once()
                except Exception as exc:  # noqa: BLE001
                    db.log(self.id, f"监控轮询异常：{exc}", "error")
                    self.on_log(f"监控轮询异常：{exc}")
                    hits = []
                # 快照按 asset_id 缓存：on_snapshot 在存图成功时回调，report_hit 时取。
                for asset_id, sim, rect in hits:
                    db.log(self.id, f"命中「{asset_id}」 相似度 {sim:.0%} 位置{rect}", "info")
                    # 走 report_hit 而不是直接落库：命中要有出口，否则盯屏的人根本不知道命中了
                    report_hit(
                        instance_id=self.id,
                        tool="monitor",
                        rule_id=asset_id,
                        matched_by="image",
                        level="alert",
                        title=_asset_name(asset_id),
                        detail=f"相似度 {sim:.0%}",
                        similarity=sim,
                        rect=rect,
                        snapshot=shots.get(asset_id, ""),
                    )
                    self.on_log(f"命中「{asset_id}」 相似度 {sim:.0%}")
                    done += 1
                    with db.write() as c:
                        c.execute("UPDATE instances SET progress_done=? WHERE id=?", (done, self.id))
                if self._stop.is_set():
                    break
                self._stop.wait(engine.poll_interval)
        finally:
            # 退出时释放抓屏句柄（mss 的 GDI/设备上下文）——
            # 之前从不调用，反复启停会一路累积；注入的假内核可能没有 shutdown
            shutdown = getattr(engine, "shutdown", None)
            if callable(shutdown):
                try:
                    shutdown()
                except Exception:  # noqa: BLE001 — 释放失败不该影响停止流程
                    pass

    def _run_guard(self, cfg: dict) -> None:
        """敏感词监控：持续读取目标窗口的待发文本，命中违禁词即落事件 + 告警。

        与 `_run_monitor` 的区别只在「匹配什么」：那边是屏幕区域里的图片模板，
        这边是窗口输入框里的文字。pause/stop 由状态机驱动，与其它工具一致。

        **去重是硬要求**：客服正在打字时，同一句话会连续几轮都被读到，
        每轮都弹窗等于把告警变成噪音，用户最后会直接把告警关掉。
        """
        from .sensitive import match_words, should_alert, summarize
        from .sensitive_words import service

        guard = cfg.get("guard") or {}
        window = str(cfg.get("window") or guard.get("window") or "").strip()
        # 事件级别用工具配置里的 alertSound（与图片监控同一套铃声/音量/静音开关）
        alert_cfg = cfg.get("alertSound")
        levels = tuple(guard.get("levels") or ("high", "mid", "low"))

        if not window:
            db.log(self.id, "没有绑定目标窗口，无法确定该读哪个输入框", "error")
            self.on_log("没有绑定目标窗口，无法确定该读哪个输入框")
            return

        grabber = build_grabber(cfg)
        # 声音告警复用图片监控那套（每个实例用自己的铃声/静音开关）。
        # 复用而不是复制一份：两处各写一套，迟早会出现"图片监控改了声音、
        # 敏感词监控没跟着改"的不一致。设备层失败静默降级，不影响告警本身。
        from .monitor import make_alert

        on_alert = make_alert(cfg)

        # 已经报过的文本指纹：同一句话不重复报。指纹用「命中词+文本摘要」，
        # 只用文本的话，改一个字就当新话报，用户会觉得系统在乱报。
        reported: dict[str, float] = {}
        #: 同一段文本的重复静默期（秒）：窗口内不再报
        dedupe_window = 120.0
        done = 0

        self.on_log(f"敏感词监控已启动：盯「{window}」，词库 {len(service.get_rules())} 条")
        try:
            while not self._stop.is_set():
                if not self._wait_gate():
                    break
                try:
                    result = grabber.poll()
                except Exception as exc:  # noqa: BLE001
                    db.log(self.id, f"抓取文本异常：{exc}", "error")
                    self.on_log(f"抓取文本异常：{exc}")
                    result = None

                if result is not None and not result.text:
                    # 抓不到内容要说清原因，否则"开了但没反应"无从排查
                    note = result.note or "这轮没有读到输入框内容"
                    self.on_log(note)
                    db.log(self.id, note, "info")
                    self._stop.wait(1.0)
                    continue

                if result is not None:
                    # 降级说明只在状态变化那一轮出现，也要写进运行详情 ——
                    # 用户事后翻日志才知道"它当时读的是剪贴板不是界面控件"
                    if result.note:
                        self.on_log(result.note)
                        db.log(self.id, result.note, "info")

                if result is not None and result.text:
                    rules = service.get_rules()
                    hits = match_words(result.text, rules)
                    if should_alert(hits, enabled_levels=levels):
                        summary = summarize(hits)
                        # 去重：同一段文本在静默期内只报一次
                        key = "%s|%s" % (summary, hash(result.text))
                        now = time.time()
                        if now - reported.get(key, 0.0) > dedupe_window:
                            reported[key] = now
                            top = hits[0]
                            # 词库命中次数 +1：用于排序与"这条规则一直没生效"的判断
                            for h in hits:
                                try:
                                    row = db.query(
                                        "SELECT id FROM sensitive_word WHERE word=? AND enabled=1",
                                        (h.word,),
                                    )
                                    if row:
                                        service.bump_hit(row[0]["id"])
                                except Exception:  # noqa: BLE001 —— 计数失败不该影响告警
                                    pass
                            # 逐条落违规事件：主管事后能按词/危级/时间抽检与统计，
                            # 计数（bump_hit）只 +1，没有这条完整记录就做不了统计。
                            service.record_violations(hits, instance_id=self.id, text=result.text)
                            report_hit(
                                instance_id=self.id,
                                tool="guard",
                                rule_id=top.word,
                                matched_by="keyword",
                                level="alert",
                                title=summary,
                                detail=result.text[:200],
                            )
                            if on_alert:
                                try:
                                    on_alert(top.word, 1.0, None)
                                except Exception:  # noqa: BLE001 —— 声音失败不该影响告警
                                    pass
                            self.on_log(f"命中：{summary}")
                            db.log(self.id, f"命中：{summary}", "warn")
                            done += 1
                            with db.write() as c:
                                c.execute(
                                    "UPDATE instances SET progress_done=? WHERE id=?", (done, self.id)
                                )
                if self._stop.is_set():
                    break
                interval = max(200, int(guard.get("pollMs") or 800)) / 1000.0
                self._stop.wait(interval)
        finally:
            close = getattr(grabber, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:  # noqa: BLE001
                    pass

    def _read_waybills(self, logi: dict) -> list[str]:
        from openpyxl import load_workbook

        wb = load_workbook(logi["file"], read_only=True)
        try:
            ws = wb[wb.sheetnames[0]]
            rows = ws.iter_rows(values_only=True)
            headers = [str(h) if h is not None else "" for h in next(rows, ())]
            idx = headers.index(logi["colWaybill"])
            out = []
            for r in rows:
                v = r[idx] if idx < len(r) else None
                if v is not None and str(v).strip():
                    out.append(str(v).strip())
            return out
        finally:
            wb.close()

    def _record(self, run_id: int, row_no: int, key: str, status: str, message: str, duration_ms: int) -> None:
        with db.write() as c:
            c.execute(
                "INSERT INTO rows(run_id, row_no, key_value, status, message, duration_ms) VALUES (?,?,?,?,?,?)",
                (run_id, row_no, key, status, message, duration_ms),
            )


_RUNNERS: dict[str, InstanceRunner] = {}
_RUNNER_LOCK = threading.Lock()


def get_runner(instance_id: str, on_log: Callable[[str], None] | None = None) -> InstanceRunner:
    with _RUNNER_LOCK:
        if instance_id not in _RUNNERS:
            _RUNNERS[instance_id] = InstanceRunner(instance_id, on_log)
        return _RUNNERS[instance_id]


def drop_runner(instance_id: str) -> InstanceRunner | None:
    """从注册表摘掉一个实例的 runner（删除实例时用），返回被摘掉的那个（没有则 None）。

    删除实例必须**同时**停线程、清注册表 —— 否则 monitor/guard 这种
    `while not stop` 的循环会继续无限轮询屏幕、继续落命中与通知，
    注册表里也永远留着一条已删实例的 runner。
    """
    with _RUNNER_LOCK:
        return _RUNNERS.pop(instance_id, None)
