import { describe, expect, it } from 'vitest'
import { detectSite, SITE_PRESETS, defaultPreset, pickPreset, probeScore, singleCarrierPresets } from './siteDetect'

/**
 * 站点适配器「自动选择」的行为规格。
 *
 * 现状问题：网页自动化查询要求用户手填 7 个 CSS 选择器
 * （输入框/按钮/结果容器/状态/轨迹…）。这不是普通用户能做的事 ——
 * 官网页面改版一次选择器就全废，而且填错了报错信息毫无帮助。
 *
 * 规格：
 *  - 内置常见快递站点预设（顺丰/中通/圆通/韵达/京东…），选站点=填好一组选择器
 *  - 能从 URL 自动判断是哪个站点（用户只要贴查询页网址）
 *  - 探测结果的**可信度**要能被解释（让用户知道能信几分）
 *  - 认不出站点时明确告知「需要手动指定」，而不是给一堆空框让人猜
 */
describe('站点适配器自动选择', () => {
  it('内置预设覆盖主流快递', () => {
    const names = SITE_PRESETS.map((p) => p.name)
    for (const carrier of ['顺丰', '中通', '圆通', '韵达', '申通']) {
      expect(names.some((n) => n.includes(carrier))).toBe(true)
    }
  })

  it('每个预设都带齐引擎要用的全部选择器_不能有空的', () => {
    for (const p of SITE_PRESETS) {
      expect(p.adapter.url).toMatch(/^https?:\/\//)
      // 这五项缺一个，查询就拿不到结果或拿不全
      for (const k of ['input', 'button', 'result', 'status', 'trace'] as const) {
        expect(p.adapter[k], `${p.name}.${k}`).toBeTruthy()
      }
    }
  })

  it('从 URL 能认出站点', () => {
    expect(pickPreset('https://www.sf-express.com/chn/sc/dynamic_function/waybill/#search')?.name).toContain('顺丰')
    expect(pickPreset('https://www.zto.com/express/expressCheck.html')?.name).toContain('中通')
    // 认不出时返回 null，不硬猜
    expect(pickPreset('https://www.some-random-shop.com/track')).toBeNull()
  })

  it('URL 大小写/带查询串/带 www 前缀都照样认得出', () => {
    expect(pickPreset('HTTPS://WWW.SF-EXPRESS.COM/track?x=1')?.name).toContain('顺丰')
    expect(pickPreset('  https://www.zto.com/  ')?.name).toContain('中通')
  })

  it('检测结果带可信度_让用户知道能信几分', () => {
    const r = detectSite('https://www.sf-express.com/track')
    expect(r.kind).toBe('preset')
    if (r.kind === 'preset') {
      expect(r.preset?.name).toContain('顺丰')
      // 可信度是 0~1 的数
      expect(r.confidence).toBeGreaterThan(0)
      expect(r.confidence).toBeLessThanOrEqual(1)
    }
  })

  it('认出站点时可一键填入选择器', () => {
    const r = detectSite('https://www.zto.com/express/expressCheck.html')
    expect(r.adapter).toBeTruthy()
    // 填入后应当是「可用的」而不是空对象
    if (r.adapter) {
      for (const k of ['input', 'button', 'result', 'status', 'trace'] as const) {
        expect(r.adapter[k]).toBeTruthy()
      }
    }
  })

  it('认不出站点时明确说「需手动指定」_不返回一堆空选择器', () => {
    const r = detectSite('https://unknown-logistics-site.com/track')
    expect(r.kind).toBe('unknown')
    expect(r).toMatchObject({ adapter: null, hint: expect.any(String) })
  })

  it('没给网址时也能走预设_用户可能只知道快递公司', () => {
    const r = detectSite('', { carrierHint: '顺丰' })
    expect(r.kind).toBe('preset')
  })

  it('探测可信度分级合理：精确匹配域名 > 仅关键字', () => {
    const exact = detectSite('https://www.sf-express.com/track')
    const fuzzy = detectSite('https://xx.sf-express.com.cn/track')
    // 无论哪种都要有 kind=preset 之一，但精确匹配可信度不该低于模糊匹配
    if (exact.kind === 'preset' && fuzzy.kind === 'preset') {
      expect(exact.confidence).toBeGreaterThanOrEqual(fuzzy.confidence)
    }
  })

  it('probeScore 给选择器完整度打分_用于提示还缺什么', () => {
    const full = { input: '#a', button: '#b', result: '.c', status: '.d', trace: '.e' }
    expect(probeScore(full)).toBe(1)
    const half = { input: '#a', button: '#b', result: '', status: '', trace: '' }
    expect(probeScore(half)).toBeLessThan(1)
    // 空的选择器集合是 0，不能是 NaN
    expect(probeScore({})).toBe(0)
  })

  // ── 聚合站：用户明确要求"快递可能是多个公司的，来回切换很麻烦" ──

  it('默认站点是快递100 聚合_一个入口查所有公司', () => {
    // 官网各家只能查自己，切换公司是用户明确说的痛点
    const d = defaultPreset()
    expect(d.name).toContain('快递100')
    expect(d.aggregate).toBe(true)
    expect(d.note).toBeTruthy()
  })

  it('快递100 能被 URL 认出来', () => {
    const p = pickPreset('https://www.kuaidi100.com/')
    expect(p?.name).toContain('快递100')
    expect(p?.aggregate).toBe(true)
  })

  it('快递100 的选择器是实测出来的_不是猜的', () => {
    const kd = SITE_PRESETS.find((p) => p.aggregate)!
    // 这些值来自用单号 R00012767627 实跑出来的 DOM。
    // 轨迹是 `li.step` —— 最初按结构猜成 `ul.content`，实测发现那是**空的壳**，
    // 等 6 秒都没有文字。这条断言就是为了钉住"别再改回猜的那个"。
    expect(kd.adapter.input).toBe('#input')
    expect(kd.adapter.result).toContain('#result')
    expect(kd.adapter.trace).toContain('li.step')
    // 聚合站的 url 指向首页本身（查询在首页完成），不是某个公司页
    expect(kd.adapter.url).toContain('kuaidi100.com')
  })

  it('官网兜底预设与聚合站分开_用户能清楚哪个是"通吃"哪个是"单家"', () => {
    const singles = singleCarrierPresets()
    expect(singles.length).toBeGreaterThan(0)
    // 兜底列表里不该再有聚合站
    expect(singles.every((p) => !p.aggregate)).toBe(true)
  })

  it('每个官网预设都声明了是哪家_避免用户以为能查所有公司', () => {
    for (const p of singleCarrierPresets()) {
      expect(p.name).toBeTruthy()
      expect(p.domains.length).toBeGreaterThan(0)
    }
  })
})

describe('域名按主机名匹配，不是整串 URL 的子串', () => {
  it('路径/查询或子域前缀里的域名片段不算命中', () => {
    // 整串 includes 会把下面两条都误判成「顺丰」，让用户以为站点被自动选对了
    expect(pickPreset('https://example.com/?ref=sf-express.com')).toBeNull()
    expect(pickPreset('https://sf-express.com.evil.cn/')).toBeNull()
  })

  it('真正的主机名仍然命中（含子域）', () => {
    expect(pickPreset('https://www.sf-express.com/order/search')?.name).toBe('顺丰')
    expect(pickPreset('https://kuaidi100.com/')?.name).toBe('快递100 聚合')
  })

  it('不带协议的主机名也能认出来', () => {
    expect(pickPreset('sf-express.cn')?.name).toBe('顺丰')
  })
})
