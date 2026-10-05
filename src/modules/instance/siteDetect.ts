/**
 * 站点适配器的「自动选择」。
 *
 * 为什么不做成让人手填选择器：官网页面改版一次选择器就全废，而让客服去研究
 * `#waybill-no` 这种东西既不现实也不该是他们做的事。所以改成：
 *   1. 贴查询页网址 → 按域名认出是哪家快递，直接填好整组选择器
 *   2. 只知道快递公司 → 从预设里挑
 *   3. 认不出 → 明确说"需要手动指定"，并把选择器逐项列出来让人改
 *
 * 探测**故意做在前端**：这些选择器是配置数据、随实例存档，用户在装好配置前
 * 就要能看到"能信几分"，不该等服务端跑起来才知道。
 */

export interface SiteAdapter {
  /** 适配器名称 */
  name: string
  /** 查询页 URL */
  url: string
  /** 单号输入框选择器 */
  input: string
  /** 查询按钮选择器 */
  button: string
  /** 结果容器选择器 */
  result: string
  /** 状态文本选择器（聚合站里是「快递公司名」，见下方 company_select 说明） */
  status: string
  /** 轨迹文本选择器 */
  trace: string
  /**
   * **存在即代表"该站自动识别快递公司"**（如快递100），值为空串。
   * 引擎侧必须用 `"company_select" in site` 判断，不能用真值判断。
   */
  company_select?: string
  /** 官网直查时的公司代号（配合 company_select 的下拉使用） */
  company?: string
  /** 官网直查时「物流状态」的选择器 */
  company_state?: string
}

export interface SitePreset {
  /** 展示名，如「顺丰」 */
  name: string
  /** 域名片段（用于从 URL 认站点） */
  domains: string[]
  adapter: SiteAdapter
  /**
   * 是否是**聚合站**：一个入口查所有快递公司。
   * 这种站不需要为每家快递配选择器，也不用在界面上切公司。
   */
  aggregate?: boolean
  /** 一句话说清它覆盖多少家、要不要手选公司 */
  note?: string
}

/** 选择器完整度需要的五项，缺一就拿不到结果 */
const REQUIRED_KEYS = ['input', 'button', 'result', 'status', 'trace'] as const

/**
 * 内置站点预设。
 *
 * 选择器取各官网查询页的稳定结构（id / class 语义名）。
 * 官网改版时这里需要更新 —— 所以 UI 上必须给"手动指定"留出口，
 * 而不是声称这套预设永远有效。
 */
export const SITE_PRESETS: SitePreset[] = [
  {
    name: '快递100 聚合',
    domains: ['kuaidi100.com'],
    aggregate: true,
    note: '一次输入，自动识别 3000+ 家快递公司 —— 不用为每家单独配，也不用切换公司',
    // ⚠️ 下面这组选择器是**实测**出来的（用单号 R00012767627 跑通），不是照着官网猜的。
    // 快递100 首页是聚合入口，填单号点「查快递」后自动识别公司。
    adapter: {
      name: '快递100（聚合查询）',
      url: 'https://www.kuaidi100.com/',
      input: '#input',
      button: 'text=查快递',
      // 结果容器：#result 里含公司名、轨迹表与 li.step 的轨迹行
      result: '#result',
      // 快递公司名（自动识别出来的，如「圆通」「融辉物流」）
      status: '#result .info-item.comname',
      // 轨迹：**li.step** 才是每条轨迹（实测：ul.content 是空的壳）
      trace: '#result li.step',
    },
  },
  {
    name: '顺丰',
    domains: ['sf-express.com', 'sf-express.cn'],
    adapter: {
      name: '顺丰官网',
      url: 'https://www.sf-express.com/chn/sc/dynamic_function/waybill/#search',
      input: 'input[placeholder*="运单"]',
      button: '.btn-search, .search-btn',
      result: '.waybill-list, .track-result',
      status: '.status, .waybill-status',
      trace: '.trace-list, .logistics-item',
    },
  },
  {
    name: '中通',
    domains: ['zto.com'],
    adapter: {
      name: '中通官网',
      url: 'https://www.zto.com/express/expressCheck.html',
      input: 'input[placeholder*="运单"], #waybillCode',
      button: '.queryButton, #queryBtn',
      result: '.result, .waybillResult',
      status: '.status, .result-status',
      trace: '.trace, .logistics',
    },
  },
  {
    name: '圆通',
    domains: ['yto.net.cn', 'yto.net'],
    adapter: {
      name: '圆通官网',
      url: 'https://www.yto.net.cn/query/order_status.html',
      input: 'input[placeholder*="运单"], #number',
      button: '.queryBtn, #query',
      result: '.result, .order-status',
      status: '.status',
      trace: '.trace-list',
    },
  },
  {
    name: '韵达',
    domains: ['yundaex.com', 'ydex.net'],
    adapter: {
      name: '韵达官网',
      url: 'https://www.yundaex.com/express/express_query.html',
      input: 'input[name*="运单"], #waybillNo',
      button: '.query, #queryBtn',
      result: '.result, .express-info',
      status: '.status',
      trace: '.trace',
    },
  },
  {
    name: '申通',
    domains: ['stoe.cn'],
    adapter: {
      name: '申通官网',
      url: 'https://www.stoe.cn/kaidi/parcelQuery',
      input: 'input[placeholder*="运单"], #billNo',
      button: '.queryBtn',
      result: '.result, .parcel',
      status: '.status',
      trace: '.trace',
    },
  },
  {
    name: '京东物流',
    domains: ['jdwl.com', 'jdl.com'],
    adapter: {
      name: '京东物流官网',
      url: 'https://www.jdwl.com/order/search',
      input: 'input[placeholder*="运单"], #waybillCode',
      button: '.search-btn, button[type=submit]',
      result: '.order-list, .result-item',
      status: '.status',
      trace: '.trace',
    },
  },
]

/** 从 URL 认出站点；认不出返回 null（不硬猜） */
export function pickPreset(url: string): SitePreset | null {
  const raw = (url ?? '').trim()
  if (!raw) return null
  // 按**主机名**匹配，而不是整串 URL 的子串：否则
  // `example.com/?ref=sf-express.com` 或 `sf-express.com.evil.cn` 都会被误认成顺丰
  let host = ''
  try {
    host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return null
  }
  if (!host) return null
  for (const p of SITE_PRESETS) {
    if (p.domains.some((d) => host === d || host.endsWith(`.${d}`))) return p
  }
  return null
}

/**
 * 默认站点：**快递100 聚合**。
 *
 * 用户的实际诉求是"快递可能是多个快递公司的，来回切换很麻烦"。
 * 聚合站一个入口查所有公司、自动识别归属 —— 所以它是默认，
 * 而各家官网预设作为"聚合站查不到时"的兜底。
 */
export const defaultPreset = (): SitePreset => SITE_PRESETS[0]

/** 兜底预设（非聚合）：官网直查 */
export const singleCarrierPresets = (): SitePreset[] => SITE_PRESETS.filter((p) => !p.aggregate)

export type DetectResult =
  | {
      kind: 'preset'
      preset: SitePreset
      adapter: SiteAdapter
      confidence: number
      source: 'url' | 'carrier'
      /** 该站是否自动识别快递公司（聚合站=true，无需手选） */
      aggregate: boolean
    }
  | { kind: 'unknown'; adapter: null; confidence: 0; source: 'none'; hint: string }

/**
 * 探测该用哪套适配器。
 *
 * `source` 与 `confidence` 都要给出来：用户看到"自动识别（精确域名匹配）"
 * 和"自动识别（仅名称匹配）"时，信任程度是不一样的，不该都写成"已识别"。
 */
export function detectSite(url: string, opts: { carrierHint?: string } = {}): DetectResult {
  const byUrl = pickPreset(url)
  if (byUrl) {
    return {
      kind: 'preset',
      preset: byUrl,
      adapter: { ...byUrl.adapter, url: (url ?? '').trim() || byUrl.adapter.url },
      // 精确命中预设里登记的域名 = 0.9；只命中名字片段再高也只给 0.7
      confidence: 0.9,
      source: 'url',
      aggregate: !!byUrl.aggregate,
    }
  }

  const hint = (opts.carrierHint ?? '').trim()
  if (hint) {
    const byName = SITE_PRESETS.find((p) => p.name === hint || p.name.includes(hint) || hint.includes(p.name))
    if (byName) {
      return {
        kind: 'preset',
        preset: byName,
        adapter: { ...byName.adapter },
        confidence: 0.7,
        source: 'carrier',
        aggregate: !!byName.aggregate,
      }
    }
  }

  return {
    kind: 'unknown',
    adapter: null,
    confidence: 0,
    source: 'none',
    // 不说"请填写选择器"就完事 —— 说清为什么认不出、下一步该做什么
    hint: url
      ? '这个网址不在内置站点列表里（覆盖顺丰/中通/圆通/韵达/申通/京东物流）。可以从列表里选一家，或手动填选择器。'
      : '填查询页网址可自动识别；也可以直接从列表里选快递公司。',
  }
}

/** 选择器完整度 0~1：用于告诉用户"这套配置还缺什么" */
export function probeScore(a: Partial<SiteAdapter> | null | undefined): number {
  if (!a) return 0
  const filled = REQUIRED_KEYS.filter((k) => !!a[k]).length
  return filled / REQUIRED_KEYS.length
}
