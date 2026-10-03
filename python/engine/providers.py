"""物流查询 Provider：不依赖接口也能用（① Excel 匹配合并 / ② 网页自动化），③ 接口为预留。

统一输出字段：company / status / signed_at / trace
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, asdict
from typing import Iterable, Protocol, runtime_checkable

from . import db
from .excel import normalize_no


@dataclass
class WaybillResult:
    no: str
    company: str = ""
    status: str = "无轨迹"
    signed_at: str = ""
    trace: str = ""

    def as_dict(self) -> dict[str, str]:
        return asdict(self)


class LogisticsProvider(ABC):
    """查询方式抽象：切换实现方式不影响上层运行器。"""

    name: str = "base"

    @abstractmethod
    def query(self, no: str) -> WaybillResult:
        ...


# ── ② 网页自动化：抓页抽象（可注入，便于测试） ──────────────────

@dataclass
class ScrapeResult:
    """一次抓页拿到的原始字段；由站点适配器里的选择器决定怎么取。"""

    company: str = ""
    status: str = ""
    signed_at: str = ""
    trace: str = ""
    captcha: bool = False


@runtime_checkable
class LogiScraper(Protocol):
    """真实抓页的可注入接口：测试用 FakeScraper，生产用 PlaywrightScraper。"""

    def scrape(self, site: dict, no: str) -> ScrapeResult:
        ...


class CaptchaEncountered(Exception):
    """抓页时撞到验证码：上层据此暂停转人工（受 logi.pauseOnCaptcha 控制）。"""

    def __init__(self, no: str) -> None:
        super().__init__(f"查询单号 {no} 时遇到验证码，需要人工处理")
        self.no = no


def detect_captcha(text: str) -> bool:
    """从页面文本里识别验证码/人机校验标记。"""
    lowered = (text or "").lower()
    markers = ("验证码", "人机验证", "安全验证", "滑动验证", "captcha", "verify you are human", "please confirm")
    return any(m in lowered for m in markers)


class ExcelMatchProvider(LogisticsProvider):
    """① Excel 匹配合并：用平台导出的对照表按单号做 VLOOKUP 式合并。

    纯本地、零外部依赖，不受页面改版与风控影响 —— 默认且推荐。
    """

    name = "excel"

    def __init__(self, ref_path: str, ref_no_col: str, ref_status_col: str) -> None:
        self._index: dict[str, dict[str, str]] = {}
        from openpyxl import load_workbook

        wb = load_workbook(ref_path, read_only=True)
        try:
            ws = wb[wb.sheetnames[0]]
            rows = ws.iter_rows(values_only=True)
            headers = [str(h) if h is not None else "" for h in next(rows, ())]
            no_i = headers.index(ref_no_col)
            st_i = headers.index(ref_status_col) if ref_status_col in headers else -1
            company_i = headers.index("快递公司") if "快递公司" in headers else -1
            time_i = headers.index("签收时间") if "签收时间" in headers else -1
            trace_i = headers.index("最新轨迹") if "最新轨迹" in headers else -1
            for r in rows:
                no = normalize_no(r[no_i]) if no_i < len(r) and r[no_i] is not None else ""
                if not no:
                    continue
                self._index[no] = {
                    "status": str(r[st_i]) if st_i >= 0 and st_i < len(r) and r[st_i] else "无轨迹",
                    "company": str(r[company_i]) if company_i >= 0 and company_i < len(r) and r[company_i] else "",
                    "signed_at": str(r[time_i]) if time_i >= 0 and time_i < len(r) and r[time_i] else "",
                    "trace": str(r[trace_i]) if trace_i >= 0 and trace_i < len(r) and r[trace_i] else "",
                }
        finally:
            wb.close()

    def query(self, no: str) -> WaybillResult:
        key = normalize_no(no)
        cached = db.query("SELECT * FROM waybill_cache WHERE no=?", (key,))
        if cached:
            c = cached[0]
            return WaybillResult(key, c["company"], c["status"], c["signed_at"], c["trace"])
        hit = self._index.get(key)
        if not hit:
            return WaybillResult(key, status="无轨迹")
        r = WaybillResult(key, hit["company"], hit["status"], hit["signed_at"], hit["trace"])
        with db.write() as c:
            c.execute(
                "INSERT OR REPLACE INTO waybill_cache(no, company, status, signed_at, trace) VALUES (?,?,?,?,?)",
                (r.no, r.company, r.status, r.signed_at, r.trace),
            )
        return r


class WebAutomationProvider(LogisticsProvider):
    """② 网页自动化查询：按站点适配器抓页，提取状态/轨迹。

    抓页动作（开浏览器、填单号、点查询、读结果）抽成可注入的 LogiScraper，
    这样不用真浏览器也能测「映射 / 缓存 / 验证码识别」。真实抓页走 PlaywrightScraper，
    其浏览器依赖全部延迟导入，构造期不要求装 playwright。
    """

    name = "web"

    def __init__(self, site: dict, interval_ms: int = 1500, scraper: LogiScraper | None = None) -> None:
        self.site = site
        self.interval_ms = interval_ms
        self._scraper = scraper

    def _get_scraper(self) -> LogiScraper:
        if self._scraper is None:
            self._scraper = _build_default_scraper()
        return self._scraper

    def query(self, no: str) -> WaybillResult:
        key = normalize_no(no)
        cached = db.query("SELECT * FROM waybill_cache WHERE no=?", (key,))
        if cached:
            c = cached[0]
            return WaybillResult(key, c["company"], c["status"], c["signed_at"], c["trace"])

        res = self._get_scraper().scrape(self.site, key)
        if res.captcha or detect_captcha(res.trace) or detect_captcha(res.status):
            raise CaptchaEncountered(key)

        r = WaybillResult(key, res.company, res.status or "无轨迹", res.signed_at, res.trace)
        with db.write() as c:
            c.execute(
                "INSERT OR REPLACE INTO waybill_cache(no, company, status, signed_at, trace) VALUES (?,?,?,?,?)",
                (r.no, r.company, r.status, r.signed_at, r.trace),
            )
        return r


class PlaywrightScraper:
    """真实抓页：Playwright 打开站点、填单号、点查询、读结果。

    浏览器依赖全部延迟导入 —— 构造期不要求装 playwright，只有首次查询才 import。
    设备层（浏览器/网络）无法在 CI 验证，测试注入 FakeScraper。
    """

    def scrape(self, site: dict, no: str) -> ScrapeResult:
        from playwright.sync_api import sync_playwright  # 延迟导入

        url = site.get("url", "")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            try:
                page.goto(url, wait_until="domcontentloaded")
                if site.get("input"):
                    page.fill(site["input"], no)
                if site.get("button"):
                    page.click(site["button"])
                if site.get("result"):
                    page.wait_for_selector(site["result"], timeout=15000)
                status = page.text_content(site["status"]) if site.get("status") else ""
                trace = page.text_content(site["trace"]) if site.get("trace") else ""
                company = page.text_content(site.get("company")) if site.get("company") else ""
                signed_at = page.text_content(site.get("signed_at")) if site.get("signed_at") else ""
                return ScrapeResult(
                    company=(company or "").strip(),
                    status=(status or "").strip(),
                    signed_at=(signed_at or "").strip(),
                    trace=(trace or "").strip(),
                    captcha=detect_captcha((status or "") + " " + (trace or "")),
                )
            finally:
                browser.close()


def _build_default_scraper() -> LogiScraper:
    return PlaywrightScraper()


class ApiProvider(LogisticsProvider):
    """③ 接口查询：快递100 / 顺丰 / 京东官方，需密钥。预留。"""

    name = "api"

    def __init__(self, api_key: str = "") -> None:
        self.api_key = api_key

    def query(self, no: str) -> WaybillResult:
        raise NotImplementedError("接口 Provider 待实现（需申请密钥）")


def build_provider(cfg: dict) -> LogisticsProvider:
    """按配置构建 Provider：新增一种查询方式只需在此加一个分支。"""
    kind = cfg.get("provider", "excel")
    if kind == "excel":
        if not cfg.get("refFile"):
            raise ValueError("Excel 匹配合并需要先选择一张对照表（含物流单号列）")
        return ExcelMatchProvider(cfg["refFile"], cfg.get("refNo", "物流单号"), cfg.get("refStatus", "物流状态"))
    if kind == "web":
        return WebAutomationProvider(cfg.get("site", {}), cfg.get("intervalMs", 1500))
    if kind == "api":
        return ApiProvider(cfg.get("apiKey", ""))
    raise ValueError(f"未知查询方式：{kind}")


def query_many(provider: LogisticsProvider, numbers: Iterable[str]) -> list[dict[str, str]]:
    return [provider.query(n).as_dict() for n in numbers]
