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

    def query(self, no: str, no_cache: bool = False) -> WaybillResult:
        """``no_cache=True`` 供连通性自检使用：不读也不写缓存（假单号别污染正式记录）。"""
        key = normalize_no(no)
        if not no_cache:
            cached = db.query("SELECT * FROM waybill_cache WHERE no=?", (key,))
            if cached:
                c = cached[0]
                return WaybillResult(key, c["company"], c["status"], c["signed_at"], c["trace"])
        hit = self._index.get(key)
        if not hit:
            return WaybillResult(key, status="无轨迹")
        r = WaybillResult(key, hit["company"], hit["status"], hit["signed_at"], hit["trace"])
        if not no_cache:
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

    def query(self, no: str, no_cache: bool = False) -> WaybillResult:
        """``no_cache=True`` 供连通性自检使用：不读也不写缓存。"""
        key = normalize_no(no)
        if not no_cache:
            cached = db.query("SELECT * FROM waybill_cache WHERE no=?", (key,))
            if cached:
                c = cached[0]
                return WaybillResult(key, c["company"], c["status"], c["signed_at"], c["trace"])

        res = self._get_scraper().scrape(self.site, key)
        if res.captcha or detect_captcha(res.trace) or detect_captcha(res.status):
            raise CaptchaEncountered(key)

        r = WaybillResult(key, res.company, res.status or "无轨迹", res.signed_at, res.trace)
        if not no_cache:
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
                # 首页常有轮播/广告，纯 domcontentloaded 后元素可能还没挂上
                page.wait_for_load_state("networkidle", timeout=15000)

                if site.get("input"):
                    page.fill(site["input"], no)
                if site.get("company_select") and site.get("company"):
                    # 只有需要手选公司时才填；聚合站是自动识别的
                    page.select_option(site["company_select"], site["company"])
                if site.get("button"):
                    page.click(site["button"], timeout=10000)

                # 等结果容器出现；等不到就明确说"没等到"，别让它把空页面当"无轨迹"
                if site.get("result"):
                    try:
                        page.wait_for_selector(site["result"], timeout=15000)
                    except Exception:
                        return ScrapeResult(
                            company="", status="查询未返回结果", signed_at="", trace="",
                            captcha=detect_captcha(page.content() or ""),
                        )
                # 轨迹是异步渲染的，容器到了不等于内容到了
                page.wait_for_timeout(1200)

                # 聚合站（快递100）里 status 选择器指向的是**快递公司名**，
                # 而各家官网查询页里它才是「物流状态」。用 company_select 是否存在
                # 来区分，否则结果表的「物流公司」和「物流状态」两列会写成同一个值。
                # 注意用 `"company_select" in site` 而不是 `.get()`：
                # 聚合站的标记值是空字符串（表示"无需手选公司"），用真值判断会走错分支
                if "company_select" in site:
                    company = self._text(page, site.get("status"))
                    status = self._text(page, site.get("company_state"))
                else:
                    status = self._text(page, site.get("status"))
                    company = self._text(page, site.get("company")) or self._text(page, site.get("comname"))
                trace = self._text(page, site.get("trace"))
                signed_at = self._text(page, site.get("signed_at"))

                # 没有独立状态列时，从轨迹首行推断物流状态（已签收/派送中/运输中…），
                # 否则「物流状态」列会是空的
                if not status and trace:
                    for kw in ("已签收", "已取件", "派送中", "运输中", "已到达", "退回", "已揽收"):
                        if kw in trace[:300]:
                            status = kw
                            break

                body = page.content() or ""
                # 聚合站查不到时会明说"不支持"/"无记录"，别把它当成"没轨迹"
                if not trace and not status:
                    if "不支持" in body or "无查询记录" in body or "查询无结果" in body:
                        return ScrapeResult(company=company, status="查无结果", trace="")
                    return ScrapeResult(company=company, status="未取到结果", trace="")

                return ScrapeResult(
                    company=company.strip(),
                    status=(status or "无轨迹").strip(),
                    signed_at=(signed_at or "").strip(),
                    trace=(trace or "").strip(),
                    captcha=detect_captcha(status + " " + trace),
                )
            finally:
                browser.close()

    @staticmethod
    def _text(page, selector: str | None) -> str:
        if not selector:
            return ""
        try:
            el = page.query_selector(selector)
            return (el.inner_text() if el else "") or ""
        except Exception:
            # 选择器写错/元素已消失：返回空让上层报"没取到"，而不是崩掉整轮
            return ""


def _build_default_scraper() -> LogiScraper:
    return PlaywrightScraper()


class ApiProvider(LogisticsProvider):
    """③ 接口查询：快递100 开放平台。

    为什么这一路最重要：**不依赖任何网页 DOM**。官网改版、加验证码、加反爬，
    都不影响接口查询 —— 用户说"一定要保证能查询到"，能真正提高确定性的就是它。

    代价是要申请密钥（快递100 个人认证免费版有次数限制，超出要付费），
    所以这里把「怎么拿密钥」「为什么报这个错」都写在错误消息里。

    走 `type=auto&tempVal=` 单号自动识别快递公司，不必自己判断单号属于哪家。
    """

    name = "api"

    # 快递100 开放平台（正式环境）。用 http 之外的域名做备用只在文档里，这里单点一处
    BASE = "https://www.kuaidi100.com/query"

    def __init__(self, api_key: str = "", customer: str = "", referer: str = "") -> None:
        key = (api_key or "").strip()
        if not key:
            # 不配就明确说，不去发一个必然 401 的请求浪费用户时间
            raise ValueError(
                "接口查询需要快递100 密钥：到 kuaidi100.com 注册并在「我的信息」里拿到"
                "客户号(CustomerKey)，填到本页「接口密钥」；查不到数据多半是这里没配"
            )
        self.api_key = key
        self.customer = (customer or "").strip()
        # 快递100 要求带 Referer 白名单；不传会返回 403
        self.referer = (referer or "https://www.kuaidi100.com").strip()

    def _request(self, no: str) -> dict:
        import urllib.parse
        import urllib.request

        payload = urllib.parse.urlencode({
            "type": "auto",       # 自动识别快递公司，省得自己判断单号归属
            "tempVal": no,
            "customer": self.customer,
            "sign": _kuaidi100_sign(self.customer, self.api_key),
        }).encode("utf-8")
        # 密钥放请求体而不是 URL：放 URL 会进网关/代理日志
        req = urllib.request.Request(
            self.BASE, data=payload, method="POST",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": self.referer,
                "User-Agent": "AutoPlayStudio/0.1",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read().decode("utf-8", "replace")
        except Exception as e:  # 网络层什么都可能坏，统一成人话
            raise ValueError("快递100 接口请求失败：%s（检查网络/代理，或该接口服务暂时不可用）" % e) from e

        import json as _json
        try:
            return _json.loads(raw)
        except ValueError as e:
            raise ValueError("快递100 接口返回的不是 JSON（可能被网关拦截或服务异常）：%s" % raw[:120]) from e

    def query(self, no: str, no_cache: bool = False) -> WaybillResult:
        """``no_cache=True`` 用于连通性自检：绕过缓存读取，也不把结果写进缓存 ——
        自检用的是假单号，写进缓存只会污染正式查询的记录。"""
        key = normalize_no(no)
        # 接口按次计费：查过的单号直接用缓存，绝不重复发请求
        if not no_cache:
            cached = db.query("SELECT * FROM waybill_cache WHERE no=?", (key,))
            if cached:
                c = cached[0]
                return WaybillResult(key, c["company"], c["status"], c["signed_at"], c["trace"])

        data = self._request(key)
        status = str(data.get("status", ""))
        message = str(data.get("message") or data.get("msg") or "")

        # 业务错误要分开说：密钥错、限流、查无结果，处理方式完全不同。
        #
        # 关键：快递100 对**错误签名**返回的是 `status=400 + message="参数错误"`，
        # 既不含"密钥"也不含"签名"。早先把它一律当"查无结果"，于是拿假密钥自检
        # 也会报"接口通了" —— 用户以为配好了，跑整批才全查不到。
        if status in ("401", "403") or "签名" in message or "密钥" in message or "校验失败" in message:
            raise ValueError("快递100 拒绝了这次请求：%s —— 请检查密钥与客户号(CustomerKey)是否正确" % (message or "签名验证失败"))
        if "频率" in message or "限制" in message or status == "429":
            raise ValueError("超出快递100 接口调用频率限制：%s（免费版次数有限，可稍后再试或改用网页自动化）" % message)
        # 400/500 且没有可解释的信息 → 归为"请求被拒"，不能当成"没查到"
        if status and status != "200" and status != "201":
            raise ValueError("快递100 没有接受这次查询：%s（status=%s）。可能是密钥/客户号不对，"
                             "也可能是该单号格式不被接受" % (message or "参数错误", status))
        # 201 = 查无结果（正常业务结果，不是错误）
        if status == "201" or not (data.get("data") or []):
            return WaybillResult(key, "", "查无结果", "", message or "快递100 未返回该单号的轨迹")

        items = data.get("data") or []
        if not items:
            return WaybillResult(key, "", "查无结果", "", message or "快递100 未返回该单号的轨迹")

        # 快递100 的 data 是**倒序**的（最新在前）；顺序反了会把三天前的状态当现状
        lines = []
        signed_at = ""
        latest = items[0]
        for it in items:
            context = (it.get("context") or "").strip()
            when = (it.get("ftime") or it.get("time") or "").strip()
            if not context:
                continue
            lines.append(("%s %s" % (when, context)).strip())
            if not signed_at and "签收" in context and when:
                signed_at = when

        result = WaybillResult(
            key,
            # 快递100 顶层响应里的 com 就是（自动识别出的）公司代码；
            # 之前在 data 条目里取 ischeck，表达式恒为空串 → 公司列永远是空的
            str(data.get("com") or "").strip(),
            (latest.get("status") or "在途").strip(),
            signed_at,
            " | ".join(lines[:10]),
        )
        # 写缓存：接口按次计费，重复查同一单号等于白花钱
        if not no_cache:
            with db.write() as c:
                c.execute(
                    "INSERT OR REPLACE INTO waybill_cache(no, company, status, signed_at, trace) VALUES (?,?,?,?,?)",
                    (result.no, result.company, result.status, result.signed_at, result.trace),
                )
        return result


def _kuaidi100_sign(customer: str, key: str) -> str:
    """快递100 签名：md5(客户号 + 密钥)，与官方文档一致（URL 编码要传 utf-8）。

    只在需要时导入 hashlib —— 绝大多数查询走网页/Excel，用不到签名。
    """
    import hashlib

    return hashlib.md5((customer + key).encode("utf-8")).hexdigest().upper()


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
        return ApiProvider(cfg.get("apiKey", ""), cfg.get("customer", ""), cfg.get("apiReferer", ""))
    raise ValueError(f"未知查询方式：{kind}")


#: 快速查单的单次上限：即时查是「人等着看结果」，塞太多会把网页方式拖成整批
MAX_QUERY_NUMBERS = 20


def parse_numbers(text: str) -> list[str]:
    """把粘贴进来的一段文本整理成单号列表：按空白/逗号切分、去空、去重、保持顺序。"""
    import re

    out: list[str] = []
    seen: set[str] = set()
    for part in re.split(r"[\s,，;；]+", text or ""):
        no = part.strip()
        if no and no not in seen:
            seen.add(no)
            out.append(no)
    return out


def query_numbers(provider: LogisticsProvider, numbers: Iterable[str]) -> list[dict[str, str]]:
    """按单号逐条即时查询，保持输入顺序。

    单条失败（撞验证码 / 请求出错）不拖垮整批：那一条标记 ok=False 并给人话，
    其余照常返回。即时查是「人等着看结果」，最忌讳一条出错整页空白。
    """
    out: list[dict[str, str]] = []
    for no in numbers:
        try:
            r = provider.query(no)
            item = r.as_dict()
            item["ok"] = True
            item["message"] = r.status
        except CaptchaEncountered:
            item = WaybillResult(no, status="待人工验证").as_dict()
            item["ok"] = False
            item["message"] = "该单号需要人工验证，请稍后重试"
        except ValueError as e:
            # Provider 主动抛的 ValueError 文案本来就是写给用户看的（缺密钥/限流…）
            item = WaybillResult(no, status="查询失败").as_dict()
            item["ok"] = False
            item["message"] = str(e)
        except Exception:  # noqa: BLE001
            # 兜底绝不把原始异常抛给用户：不熟练的人看到技术报错只会更慌
            item = WaybillResult(no, status="查询失败").as_dict()
            item["ok"] = False
            item["message"] = "暂时查不到，请稍后重试"
        out.append(item)
    return out
