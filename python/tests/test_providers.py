"""Seam 3：物流 Provider 合并。

不依赖任何外部接口 —— 用平台导出的对照表做 VLOOKUP 式合并，统一输出
company / status / signed_at / trace，上层运行器不关心数据从哪来。
"""
from __future__ import annotations

import pytest

from engine.providers import (
    ApiProvider,
    CaptchaEncountered,
    ExcelMatchProvider,
    ScrapeResult,
    WebAutomationProvider,
    build_provider,
    detect_captcha,
    query_many,
)


class FakeScraper:
    """测试用抓页替身：按单号返回 canned 结果，记录被调用了什么。"""

    def __init__(self, results: dict[str, ScrapeResult]) -> None:
        self.results = results
        self.calls: list[tuple[dict, str]] = []

    def scrape(self, site: dict, no: str) -> ScrapeResult:
        self.calls.append((site, no))
        return self.results.get(no, ScrapeResult())


def excel_provider(ref_xlsx) -> ExcelMatchProvider:
    return ExcelMatchProvider(ref_xlsx, "物流单号", "物流状态")


def test_known_waybill_is_merged_from_reference_table(ref_xlsx):
    r = excel_provider(ref_xlsx).query("SF1234567890")

    assert r.as_dict() == {
        "no": "SF1234567890",
        "company": "顺丰速运",
        "status": "已签收",
        "signed_at": "10-01 15:22",
        "trace": "【深圳市】快件已签收",
    }


def test_unknown_waybill_reports_no_trace(ref_xlsx):
    r = excel_provider(ref_xlsx).query("SF-NOT-EXIST")

    assert r.status == "无轨迹"
    assert r.company == ""
    assert r.trace == ""


def test_waybill_number_is_trimmed(ref_xlsx):
    """Excel 里单号常带首尾空格或全角空格，必须归一化后再匹配。"""
    assert excel_provider(ref_xlsx).query("  SF1234567890 ").status == "已签收"


def test_query_result_is_cached(ref_xlsx, xlsx_factory):
    excel_provider(ref_xlsx).query("SF1234567890")

    # 换成一张空对照表：仍应查到结果，说明走了本地缓存
    empty = xlsx_factory(["物流单号"], [], name="empty_ref.xlsx")
    assert ExcelMatchProvider(empty, "物流单号", "物流状态").query("SF1234567890").status == "已签收"


def test_query_many_keeps_input_order(ref_xlsx):
    out = query_many(excel_provider(ref_xlsx), ["YT9876543210", "SF1234567890", "UNKNOWN"])

    assert [o["no"] for o in out] == ["YT9876543210", "SF1234567890", "UNKNOWN"]
    assert out[0]["company"] == "圆通速递"
    assert out[1]["company"] == "顺丰速运"
    assert out[2]["status"] == "无轨迹"


def test_build_provider_picks_the_right_implementation(ref_xlsx):
    assert isinstance(
        build_provider({"provider": "excel", "refFile": ref_xlsx, "refNo": "物流单号", "refStatus": "物流状态"}),
        ExcelMatchProvider,
    )
    assert isinstance(build_provider({"provider": "web", "site": {"url": "https://example.com"}}), WebAutomationProvider)
    assert isinstance(build_provider({"provider": "api", "apiKey": "k"}), ApiProvider)


def test_build_provider_rejects_unknown_kind():
    with pytest.raises(ValueError, match="未知查询方式"):
        build_provider({"provider": "telepathy"})


def test_excel_provider_requires_a_reference_table():
    with pytest.raises(ValueError, match="对照表"):
        build_provider({"provider": "excel"})


# ── ② 网页自动化 Provider：抓页可注入，便于测试 ──────────────

def test_detect_captcha_finds_markers():
    assert detect_captcha("请拖动滑块完成验证码")
    assert detect_captcha("Please verify you are human")
    assert detect_captcha("滑动验证")


def test_detect_captcha_ignores_normal_trace():
    assert not detect_captcha("【深圳市】快件已签收")
    assert not detect_captcha("运输中")


def test_web_provider_maps_scraper_result():
    scraper = FakeScraper({"SFA": ScrapeResult(company="顺丰", status="已签收", signed_at="10-01", trace="已签")})
    r = WebAutomationProvider({"url": "x"}, 1500, scraper=scraper).query("SFA")

    assert r.company == "顺丰"
    assert r.status == "已签收"
    assert r.signed_at == "10-01"
    assert r.trace == "已签"


def test_web_provider_normalizes_no_before_scraping():
    scraper = FakeScraper({"SFB": ScrapeResult(status="已签收")})
    WebAutomationProvider({}, 1500, scraper=scraper).query(" SFB ")
    assert scraper.calls[-1][1] == "SFB"  # 单号先归一化再抓页


def test_web_provider_caches_scrape_results():
    scraper = FakeScraper({"SFC": ScrapeResult(status="已签收")})
    provider = WebAutomationProvider({}, 1500, scraper=scraper)
    provider.query("SFC")
    provider.query("SFC")
    assert len(scraper.calls) == 1  # 第二次走 waybill_cache，不再抓页


def test_web_provider_raises_captcha_when_scraper_signals():
    scraper = FakeScraper({"SFD": ScrapeResult(captcha=True)})
    with pytest.raises(CaptchaEncountered):
        WebAutomationProvider({}, 1500, scraper=scraper).query("SFD")


def test_web_provider_raises_captcha_when_trace_mentions_it():
    scraper = FakeScraper({"SFE": ScrapeResult(trace="请完成安全验证")})
    with pytest.raises(CaptchaEncountered):
        WebAutomationProvider({}, 1500, scraper=scraper).query("SFE")


def test_web_provider_builds_with_real_scraper_by_default():
    """不传 scraper 时默认挂上 PlaywrightScraper（构造期不 import playwright）。"""
    p = build_provider({"provider": "web", "site": {"url": "https://example.com"}})
    assert isinstance(p, WebAutomationProvider)
    assert p._scraper is None  # 真实抓页延迟到首次查询才构造
