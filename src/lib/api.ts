import { normalizeInstance, normalizeInstances } from '@/lib/instanceNormalize'
import type { Instance, Row, InstanceConfig } from '@/schemas/instance'
import { hitEventQuery, type HitEvent, type HitEventQuery } from '@/lib/hitEvents'
import {
  violationQuery,
  type ViolationEvent,
  type ViolationQuery,
  type ViolationSummary,
} from '@/lib/violationStats'
import { ipc } from '@/lib/ipc'

/** 拿不到 Electron 桥注入的端口时的兜底（仅纯浏览器预览 / 单测会走到）。 */
const FALLBACK_ENGINE_PORT = 8731

/**
 * 当前加载协议：`file:` = 打包态（渲染进程从磁盘加载，相对路径不可用）；其余 = 开发态。
 *
 * **每次调用时才读**，不在模块加载时快照 —— preload 注入的时机不保证早于渲染层模块求值，
 * 快照一次会把「本来有」误判成「没有」（同一个坑见 ipc.ts 的 bridge 注释）。
 */
export const engineProtocol = (): string =>
  typeof location !== 'undefined' && location.protocol === 'file:' ? 'file:' : 'http:'

/**
 * 开发态（http://localhost:5173）用同源相对路径，由 Vite 代理转发 /api 与 /ws；
 * 打包后用 `http://127.0.0.1:<端口>` 直连本机引擎。
 *
 * 端口不在这里写死：由主进程经 preload 同步注入（electron/main.ts 的 `--engine-port=`）。
 */
export function resolveEngineOrigin(protocol: string, port: number | null): string {
  if (protocol !== 'file:') return ''
  return `http://127.0.0.1:${port ?? FALLBACK_ENGINE_PORT}`
}

/** `/api` 前缀的基地址。**每次调用时解析**，不缓存。 */
export const apiBase = (): string => `${resolveEngineOrigin(engineProtocol(), ipc.enginePort())}/api`

/**
 * 方案（可复用的配置模板）：全局存一份，跨工具、跨实例复用。
 *
 * 它跟实例**不双向同步** —— 存的是快照，之后改实例不改方案，改方案不改已有实例。
 */
export interface Plan {
  id: string
  tool: string
  name: string
  config: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/** 一张已上传的对比表 */
export interface CompareTable {
  name: string
  path: string
  columns: string[]
  rows: number
}

export type CompareStatus = 'ok' | 'diff' | 'missing' | 'extra' | 'error' | 'unknown'

export interface CompareReport {
  header: string[]
  rows: Array<{
    cells: Record<string, string>
    status: CompareStatus
    cell_status: Record<string, CompareStatus>
    note: string
    is_extra: boolean
  }>
  summary: Record<string, number>
  warnings: string[]
  cmp_fields: string[]
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiBase() + input, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  // 非 2xx 交给 failWith：引擎把「为什么不行」写成了给人看的中文，
  // 这里若只抛一句 `GET /excel/inspect?... failed: 404`，用户看到的是地址栏。
  if (!res.ok) return failWith(res, `${init?.method ?? 'GET'} ${input} failed: ${res.status}`)
  return res.json() as Promise<T>
}

/** POST 一份 JSON 的请求体（工具箱那七个接口全是这个形状） */
const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
})

/** 一次崩溃恢复的明细：哪个实例从什么状态被复位、保留了多少进度 */
export interface RecoveryPlan {
  id: string
  name: string
  from: string
  to: string
  done: number
  total: number
}

export interface RecoverySummary {
  recovered: number
  plans: RecoveryPlan[]
}

/** 从错误响应里挖出后端给的 detail / message，挖不到再退回一句通用话 */
async function failWith(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { detail?: string; message?: string }
  throw new Error(body.detail ?? body.message ?? fallback)
}

// ── 图像素材库 ──────────────────────────────────────────────

/** 一张素材。refCount = 有几条指令在用它，列表上要显示角标 */
export interface ImageAsset {
  id: string
  name: string
  path: string
  width: number
  height: number
  threshold: number
  tag: string
  createdAt: string
  refCount: number
}

/** 素材被引用的位置 */
export interface AssetRef {
  instanceId: string
  instanceName: string
  cmdIndex: number
  cmdName: string
}

/** 体检问题：引用了不存在的素材 / 素材文件丢了 */
export interface AssetProblem extends AssetRef {
  assetId: string
  kind: 'missing_asset' | 'missing_file'
  detail: string
}

/** 删被引用的素材时后端回 409；带上「谁在用」好弹确认框 */
export class AssetInUseError extends Error {
  readonly refs: AssetRef[]

  constructor(message: string, refs: AssetRef[]) {
    super(message)
    this.name = 'AssetInUseError'
    this.refs = refs
  }
}

/** 一条搜索历史。`usedAt` 只到秒，所以**顺序靠后端按自增 id 给**，不要在前端按时间排 */
export interface KbHistoryItem {
  query: string
  resultCount: number
  usedAt: string
}

/** 一个已登记进知识库的文件夹 */
export interface KbFolder {
  /** 已归一化的绝对路径（正斜杠）；作为该文件夹的稳定标识 */
  path: string
  name: string
  docCount: number
}

export interface KbIndexing {
  running: boolean
  done: number
  total: number
  /** 正在处理哪个文件 —— 几千份文档时，没有这一条就看不出它是不是卡住了 */
  current: string
}

export interface KbStatus {
  /** 段落数（一份文档切多段） */
  docCount: number
  /** 文件数。命中一个文档时 `fileName` 是它，去重按 path */
  fileCount: number
  folders: KbFolder[]
  indexing: KbIndexing
  /** 读不出来的文件：`文件名：原因`。不中断整轮索引，但必须让用户看见 */
  failed: string[]
  /** 有没有语义检索能力（本机装了 embedding 模型才有）。空结果时据此改引导话术 */
  semanticEnabled: boolean
}

/** 一段命中片段 */
export interface KbSnippet {
  line: number
  text: string
}

/** 一条搜索结果 */
export interface KbHit {
  path: string
  fileName: string
  fileType: string
  size: number
  mtime: number
  /** 内容超长被截断：搜索结果只覆盖文件前一段，要如实说出来 */
  truncated: boolean
  score: number
  /** 'and' = 全部关键词都命中；'or' = 兜底放宽过 */
  matchMode: 'and' | 'or'
  /** 一共命中几处（`snippets` 只给前几段） */
  matchCount: number
  snippets: KbSnippet[]
  /** 怎么找到的：keyword=字面命中 · semantic=语义命中 · both=两路都命中 */
  matchedBy: 'keyword' | 'semantic' | 'both'
}

export interface KbSearchResponse {
  query: string
  count: number
  results: KbHit[]
}

/**
 * 速查填入的目标：客服客户端的窗口 + 输入框在屏幕上那块矩形。
 *
 * 与引擎 `/api/assist` 的 `Target` 一一对应。窗口是**关键字**不是精确标题 ——
 * 引擎按「标题包含」激活窗口，所以「千牛」就能匹到「千牛工作台 - 客服」。
 */
export interface AssistTarget {
  window: string
  x: number
  y: number
  width: number
  height: number
}

/** 表格体检里的一条问题 */
export interface PrepIssue {
  /** 规则名，与引擎 `engine/excel_prep/rules.py` 里的 kind 一一对应 */
  kind: string
  /** `fix` 整理时自动应用 · `risk` 默认不应用（要用户勾选）· `info` 只报不改 */
  severity: 'info' | 'fix' | 'risk'
  /** 涉及的行号，**原文件的行号**（整理后行号会漂，用户对不上） */
  rows: number[]
  /** 涉及的列序号（1 起）。表头类问题的主语是列，行级问题是空数组 */
  cols: number[]
  detail: string
}

// ── Excel 工具箱 ──
/** 读列名 + 行数。工具箱每个工具的「选列」下拉都靠它 */
export interface ToolboxColumns {
  columns: string[]
  rowCount: number
}

/** 补全列：可以是列名字符串，也可以是 {from, to} 改列名 */
export type FillColumn = string | { from: string; to: string }

export interface ToolboxMergeIn {
  mainPath: string
  srcPath: string
  /** 匹配键可以有若干列，「订单号+买家」一起才能唯一定位一行 */
  mainKeys: string[]
  srcKeys: string[]
  fillColumns: FillColumn[]
}

/** 工具产出：原表只读，出的是同目录下的新文件 */
export interface ToolboxResult {
  path: string
  rowCount: number
  columns?: string[]
  /** 合并专用：匹配上来源表的行数 */
  matchedCount?: number
}

export interface ToolboxSplitResult {
  files: Array<{ value: string; path: string; rowCount: number }>
  count: number
}

/** 一次体检的报告 */
export interface PrepReport {
  path: string
  sheet: string
  /** 表头在第几行。不是 1 的时候，按第 1 行读表头会读到空列名 */
  headerRow: number
  /** 列名，按列序；空列名是 `null`（占位列） */
  columns: (string | null)[]
  /** 表头之后的行数（含空行）—— 用来解释「说 9 行，跑起来只有 6 行有内容」 */
  dataRows: number
  keyCol: string
  issues: PrepIssue[]
}

/** 台账里的一处改动。`row` / `col` 都是**原文件**的坐标，0 表示不涉及 */
export interface PrepChange {
  kind: string
  detail: string
  row: number
  col: number
  before: unknown
  after: unknown
}

/** 整理的产物 + 逐处改动台账 */
export interface PrepLog {
  output: string
  fileName: string
  sheet: string
  /** 输出第 i 行来自原文件的哪一行 */
  rowsKept: number[]
  colsKept: number[]
  changes: PrepChange[]
}

/** 一轮失败原因归类的分组 */
export interface SummaryReason {
  label: string
  count: number
  rows: number[]
}

/** 待人工确认清单里的一条 */
export interface PendingRow {
  row: number
  key: string
  reason: string
}

/** 最近一轮的结论 */
export interface RunSummary {
  total: number
  ok: number
  failed: number
  skipped: number
  /** 一句话结论，引擎拼好 —— 前端不再算一遍，否则两处迟早对不上 */
  headline: string
  reasons: SummaryReason[]
  /** 没列进 `reasons` 的类数（页面用它写「另有 N 类」） */
  otherReasons: number
  pending: PendingRow[]
}

/** 通知配置：通道启停 + 每个级别走哪些通道 + webhook + 静音时段 */
export interface NotifyConfig {
  channels: Record<string, boolean>
  routing: Record<string, string[]>
  webhook: { url: string; kind: string }
  quiet: { enabled: boolean; from: string; to: string }
}

/** 一条运单结果（waybill_cache 与各 provider 的共同形状） */
export interface WaybillRow {
  no: string
  company: string
  status: string
  signed_at: string
  trace: string
}

/** 即时查单返回的一条：比缓存多 `ok`/`message`，用来判断这条是否查成 */
export interface LogiQueryItem extends WaybillRow {
  ok: boolean
  message: string
}

/** 最近查单记录里的一条：多一个更新时间，用于展示与排序 */
export interface LogiRecentItem extends WaybillRow {
  updated_at: string
}

export const api = {
  // 实例一律过一遍归一化：引擎的老记录会缺 columns / hotkeys 这类后加字段
  listInstances: async () => normalizeInstances(await json<unknown>('/instances')),

  // ── 崩溃恢复 ──
  /** 手动触发对账：把残留的 live 状态复位，返回恢复数量与明细 */
  recoverInstances: () => json<RecoverySummary>('/instances/recover', { method: 'POST' }),

  /** 引擎启动时那次恢复的结果，控制台用来展示「已恢复 N 个被中断实例」 */
  recoverySummary: () => json<RecoverySummary>('/instances/recovery'),

  /** planId：从哪个方案起手。方案只是把配置拷一份过来，之后与实例互不影响 */
  createInstance: (payload: { name: string; tool: Instance['tool']; planId?: string }) =>
    json<unknown>('/instances', { method: 'POST', body: JSON.stringify(payload) }).then(normalizeInstance),

  saveConfig: (id: string, config: InstanceConfig) =>
    json<{ ok: true }>(`/instances/${id}/config`, { method: 'PUT', body: JSON.stringify(config) }),

  control: (id: string, action: 'start' | 'pause' | 'resume' | 'stop') =>
    json<{ ok: true; status: string }>(`/instances/${id}/control/${action}`, { method: 'POST' }),

  clone: (id: string) => json<unknown>(`/instances/${id}/clone`, { method: 'POST' }).then(normalizeInstance),

  /** 改名：名字是用户识别实例的主要依据，建完就该能改 */
  rename: (id: string, name: string) =>
    json<{ ok: true; name: string; old?: string }>(`/instances/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  remove: (id: string) => json<{ ok: true }>(`/instances/${id}`, { method: 'DELETE' }),

  rows: (id: string) => json<Row[]>(`/instances/${id}/rows`),

  logs: (id: string) => json<Array<{ ts: string; level: string; message: string }>>(`/instances/${id}/logs`),

  /** 桌面监控命中事件（最新在前） */
  monitorHits: (id: string) =>
    json<Array<{ assetId: string; similarity: number; rect: number[] | null; ts: string }>>(
      `/instances/${id}/monitor-hits`,
    ),

  // ── 命中事件（工单 02）──
  /** 跨实例的命中事件；不带筛选就是看全局 */
  hitEvents: (q: HitEventQuery = {}) => {
    const s = hitEventQuery(q)
    return json<HitEvent[]>(`/hit-events${s ? `?${s}` : ''}`)
  },

  /** 未读命中数：托盘角标与页面红点 */
  hitUnreadCount: () => json<{ count: number }>('/hit-events/unread-count'),

  // ── 违规事件（工单 04 · ④⑤）：敏感词命中落库的记录
  /** 违规事件列表；不带筛选看全局（默认按本机用户 / 词 / 危级 / 时间四轴） */
  violations: (q: ViolationQuery = {}) => {
    const s = violationQuery(q)
    return json<ViolationEvent[]>(`/violations${s ? `?${s}` : ''}`)
  },

  /** 违规聚合：总数 + 按词计数 + 按危级计数；统计页卡片直接消费 */
  violationSummary: (q: ViolationQuery = {}) => {
    const s = violationQuery(q)
    return json<ViolationSummary>(`/violations/summary${s ? `?${s}` : ''}`)
  },

  /** 标记已读；ids 为空数组 = 全部标记 */
  markHitsRead: (ids: number[] = []) =>
    json<{ marked: number }>('/hit-events/read', { method: 'POST', body: JSON.stringify({ ids }) }),

  /** 确认命中事件（已处理，闭环）；ids 为空数组 = 全部确认 */
  ackHits: (ids: number[] = []) =>
    json<{ acked: number }>('/hit-events/ack', { method: 'POST', body: JSON.stringify({ ids }) }),

  notifyConfig: () => json<NotifyConfig>('/settings/notify'),

  /** 合入一块通知配置（配置页每次只提交当前那一块），回完整配置 */
  saveNotifyConfig: (patch: Partial<NotifyConfig>) =>
    json<NotifyConfig>('/settings/notify', { method: 'PUT', body: JSON.stringify(patch) }),

  /** 测试发送：走所有启用通道，回逐通道结果（失败原因给用户看） */
  testNotify: () => json<Record<string, string>>('/settings/notify/test', { method: 'POST' }),

  uploadExcel: async (id: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${apiBase()}/instances/${id}/excel`, { method: 'POST', body: fd })
    if (!res.ok) throw new Error('upload failed')
    return res.json() as Promise<{
      columns: string[]
      rows: number
      path: string
      /** 第 2 行（跳过前导空行）的真值，配置页的实时预览用它渲染 */
      sample: { row_no: number; key: string; values: Record<string, unknown> }
    }>
  },

  /**
   * 拿引擎读到的**真实表头**再校一遍模板。
   *
   * 前端那份校验用的是上传时的列缓存 —— 用户把 Excel 换掉之后缓存就不作数了，
   * 所以保存时让引擎重新读一次文件。
   */
  checkTemplate: (excelPath: string, templates: string[]) =>
    json<{ columns: string[]; issues: { index: number; template: string; message: string }[] }>(
      '/template/check',
      { method: 'POST', body: JSON.stringify({ excelPath, templates }) },
    ),

  // ── Excel 多表对比 ──
  /** role=primary 上传 A 表（基准），role=other 上传 B/C 表 */
  uploadCompareTable: async (id: string, role: 'primary' | 'other', file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${apiBase()}/instances/${id}/compare/upload?role=${role}`, { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.json().catch(() => ({ detail: '上传失败' }))).detail ?? '上传失败')
    return res.json() as Promise<CompareTable>
  },

  autoMap: (id: string, tableName?: string) =>
    json<{ maps: Record<string, Record<string, string | null>> }>(
      `/instances/${id}/compare/auto-map${tableName ? `?table_name=${encodeURIComponent(tableName)}` : ''}`,
      { method: 'POST' },
    ),

  /** 移除一张已上传的对比表。走 apiBase()（打包态 file:// 下相对路径会失败） */
  removeCompareTable: (id: string, name: string) =>
    json<{ ok: true }>(`/instances/${id}/compare/table?name=${encodeURIComponent(name)}`, { method: 'DELETE' }),

  runCompare: (id: string) =>
    json<{ report: CompareReport; outFile: string; runId: number }>(`/instances/${id}/compare/run`, { method: 'POST' }),

  compareReportPath: (id: string) => json<{ path: string }>(`/instances/${id}/compare/report`),

  /** 上一次的对比结果（页面上刷新后仍能还原） */
  compareResult: (id: string) => json<CompareReport>(`/instances/${id}/compare/result`),

  /** 把当前的字段角色 / 列映射 / 容差存成方案（进全局库，删实例不丢） */
  savePlan: (id: string, name: string) =>
    json<{ id: string; name: string }>(`/instances/${id}/compare/plan`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  /** 把方案里的字段角色 / 列映射 / 容差套回当前实例（按主表名匹配） */
  applyPlan: (id: string, planId: string) =>
    json<{ ok: true; name: string; tolerance: number }>(`/instances/${id}/compare/plan/apply`, {
      method: 'POST',
      body: JSON.stringify({ planId }),
    }),

  // ── 方案（配置模板）──
  listPlans: (tool?: string) => json<Plan[]>(`/plans${tool ? `?tool=${encodeURIComponent(tool)}` : ''}`),

  createPlan: (payload: { tool: string; name: string; config: Record<string, unknown> }) =>
    json<{ id: string }>('/plans', { method: 'POST', body: JSON.stringify(payload) }),

  patchPlan: (id: string, patch: { name?: string; config?: Record<string, unknown> }) =>
    json<Plan>(`/plans/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  removePlan: (id: string) => json<{ ok: true }>(`/plans/${id}`, { method: 'DELETE' }),

  // ── 图像素材库 ──
  listImages: () => json<ImageAsset[]>('/images'),

  /** 导入外部图片。name / tag / threshold 不传就用后端的默认值 */
  uploadImage: async (file: File, opts: { name?: string; tag?: string; threshold?: number } = {}) => {
    const fd = new FormData()
    fd.append('file', file)
    if (opts.name !== undefined) fd.append('name', opts.name)
    if (opts.tag !== undefined) fd.append('tag', opts.tag)
    if (opts.threshold !== undefined) fd.append('threshold', String(opts.threshold))
    const res = await fetch(`${apiBase()}/images`, { method: 'POST', body: fd })
    if (!res.ok) await failWith(res, '上传图片失败')
    return res.json() as Promise<ImageAsset>
  },

  /** 区域截图：坐标与宽高原样发给后端去抓屏 */
  captureImage: (payload: { name?: string; x: number; y: number; width: number; height: number }) =>
    json<ImageAsset>('/images/capture', { method: 'POST', body: JSON.stringify(payload) }),

  updateImage: (id: string, patch: { name?: string; tag?: string; threshold?: number }) =>
    json<ImageAsset>(`/images/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  assetRefs: (id: string) => json<AssetRef[]>(`/images/${id}/references`),

  /** 体检整库：引用了不存在的素材 / 素材文件丢了 */
  auditImages: () => json<AssetProblem[]>('/images/audit'),

  /** 删素材。被引用时抛 AssetInUseError，前端据此弹「谁在用」并询问是否强删 */
  deleteImage: async (id: string, opts: { force?: boolean } = {}) => {
    const res = await fetch(`${apiBase()}/images/${id}${opts.force ? '?force=true' : ''}`, { method: 'DELETE' })
    if (res.status === 409) {
      const body = (await res.json()) as { message: string; refs: AssetRef[] }
      throw new AssetInUseError(body.message, body.refs)
    }
    if (!res.ok) await failWith(res, '删除素材失败')
    return res.json() as Promise<{ deleted: boolean; clearedRefs: number }>
  },

  /** 原图地址：直接喂给 <img src>，省掉 base64 来回转换 */
  imageRawUrl: (id: string) => `${apiBase()}/images/${id}/raw`,

  /** 视频抽帧：均匀抽成图像素材（标签「视频帧」），返回每帧的素材描述 */
  extractVideo: async (file: File, maxFrames = 24) => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('max_frames', String(maxFrames))
    const res = await fetch(`${apiBase()}/video/extract`, { method: 'POST', body: fd })
    if (!res.ok) await failWith(res, '视频抽帧失败')
    return res.json() as Promise<{ frames: Array<ImageAsset & { ts: number }>; count: number }>
  },

  // ── 知识库（内容搜索） ──
  kbStatus: () => json<KbStatus>('/kb/status'),
  /**
   * 全文检索。支持中文、拼音首字母（tkzc → 退款政策）与 `type:pdf` 这类过滤，
   * 解析与排序都在引擎里做；前端只负责把结果画出来。
   */
  kbSearch: (q: string, limit?: number) =>
    json<KbSearchResponse>(`/kb/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`),

  /** 登记一个文件夹（登记后引擎在后台索引，进度看 kbStatus().indexing） */
  kbAddFolder: (path: string) =>
    json<{ folder: KbFolder | null; started: boolean }>('/kb/folders', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  /** 注销文件夹：它的文档与索引一并撤回（不删磁盘文件） */
  kbRemoveFolder: (path: string) =>
    json<{ removed: number }>(`/kb/folders?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),

  kbReindex: () => json<{ started: boolean }>('/kb/reindex', { method: 'POST' }),

  kbHistory: (limit = 20) => json<{ items: KbHistoryItem[] }>(`/kb/history?limit=${limit}`),

  kbClearHistory: () => json<{ ok: true }>('/kb/history', { method: 'DELETE' }),

  /** 用系统默认程序打开一个**已索引**的文件；引擎只认库里的路径 */
  kbOpen: async (path: string) => {
    const res = await fetch(`${apiBase()}/kb/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    if (!res.ok) await failWith(res, '打开文件失败')
    return res.json() as Promise<{ ok: true }>
  },

  // ── 速查填入（知识库话术 → 客服客户端输入框） ──
  //
  // 只填不发送：发送键由客服自己按。这是这条链路里唯一不能省的人工闸门。
  assistTarget: () => json<{ target: AssistTarget | null }>('/assist/target'),

  saveAssistTarget: (target: AssistTarget) =>
    json<{ target: AssistTarget }>('/assist/target', { method: 'PUT', body: JSON.stringify(target) }),

  /** 当前打开的窗口标题 —— 给用户从真实存在的标题里挑，而不是自己猜 */
  assistWindows: () => json<{ windows: string[]; reason: string }>('/assist/windows'),

  /** 把一段话术填进框定的输入框。不发送。 */
  assistFill: (text: string) =>
    json<{ filled: boolean; window: string }>('/assist/fill', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  // ── 表格体检与整理 ──
  /**
   * 只读体检。`keyCol` 可以留空（用户还没选主键列时页面也要先显示列名给他挑）。
   * 文件不存在回 404、后缀不对或主键列写错回 400，`failWith` 会把引擎那句话原样带出来。
   */
  excelInspect: (path: string, keyCol = '') =>
    json<PrepReport>(`/excel/inspect?path=${encodeURIComponent(path)}&keyCol=${encodeURIComponent(keyCol)}`),

  /** 整理：原文件不动，出「原名_已整理.xlsx」并返回台账 */
  excelClean: (path: string, keyCol: string, acceptRisk: boolean) =>
    json<PrepLog>('/excel/clean', {
      method: 'POST',
      body: JSON.stringify({ path, keyCol, acceptRisk }),
    }),

  /** 打开整理后的文件；引擎只认它自己这一轮产出过的路径 */
  excelOpen: async (path: string) => {
    const res = await fetch(`${apiBase()}/excel/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    if (!res.ok) await failWith(res, '打开文件失败')
    return res.json() as Promise<{ ok: true }>
  },

  /** 整理后文件的下载地址。直接喂给 `<a href>` —— 白名单在引擎那一侧守 */
  excelDownloadUrl: (path: string) => `${apiBase()}/excel/download?path=${encodeURIComponent(path)}`,

  // ── Excel 工具箱 ──
  // 产出都是**原表同目录下的新文件**（原文件只读），所以这里不给下载接口：
  // 走下载要过引擎的路径白名单，绕一圈不如直接让用户打开所在文件夹。
  /** 读某张表的列名与行数：所有工具的"选列"下拉都靠它 */
  toolboxColumns: (path: string) =>
    json<ToolboxColumns>(`/excel-toolbox/columns?path=${encodeURIComponent(path)}`),

  /** 合并/补全：mainKeys 与 srcKeys 都可以有多列，列数由用户决定 */
  toolboxMerge: (p: ToolboxMergeIn) => json<ToolboxResult>('/excel-toolbox/merge', postJson(p)),

  /** 按勾选的列生成新表，列序 = 勾选顺序 */
  toolboxGenerate: (path: string, columns: string[]) =>
    json<ToolboxResult>('/excel-toolbox/generate', postJson({ path, columns })),

  toolboxDedupe: (path: string, keys: string[]) =>
    json<ToolboxResult & { removedCount: number }>('/excel-toolbox/dedupe', postJson({ path, keys })),

  toolboxConvert: (path: string, target: 'xlsx' | 'csv') =>
    json<ToolboxResult & { format: string }>('/excel-toolbox/convert', postJson({ path, target })),

  /** 按列拆分成多个文件 */
  toolboxSplit: (path: string, column: string) =>
    json<ToolboxSplitResult>('/excel-toolbox/split', postJson({ path, column })),

  toolboxFilter: (path: string, column: string, value: string) =>
    json<ToolboxResult>('/excel-toolbox/filter', postJson({ path, column, value })),

  /** 问题行导出：带 Excel 行号与原因，方便回原表改 */
  toolboxProblemRows: (path: string, keyColumn: string) =>
    json<ToolboxResult>('/excel-toolbox/problem-rows', postJson({ path, keyColumn })),

  /** 最近一轮的结论：一句话 + 失败原因归类 + 待人工确认清单 */
  runSummary: (id: string) => json<RunSummary>(`/instances/${id}/summary`),

  /**
   * 物流查询连通性自检：跑大批量之前先探一次路。
   * `stage= "config"` 表示卡在配置（缺密钥/缺选择器，出网前就拦住了）；
   * `"query"` 表示已经发过请求、问题在那一侧。
   */
  probeLogi: (id: string) =>
    json<{
      ok: boolean
      stage: 'config' | 'query'
      message: string
      missing?: string[]
      sample?: { status: string; trace: string }
    }>(`/instances/${id}/logi-probe`, { method: 'POST' }),

  /** 单号即时查：粘贴一个或多个单号，逐条返回，单条失败不影响整批 */
  logiQuery: (id: string, numbers: string) =>
    json<{ items: LogiQueryItem[]; count: number }>(
      `/instances/${id}/logi-query`,
      postJson({ numbers }),
    ),

  /** 最近查过的单号（全局缓存，按更新时间倒序） */
  logiRecent: (id: string, limit = 10) =>
    json<{ items: LogiRecentItem[]; count: number }>(`/instances/${id}/logi-recent?limit=${limit}`),

  // ── 话术库（客服） ──
  /**
   * 话术列表。引擎侧已按「常用在前」排好序 —— 前端不要重排，
   * 否则会盖掉「用得多就往前挪」这个最符合直觉的规则。
   */
  listPhrases: (q: { q?: string; category?: string } = {}) => {
    const p = new URLSearchParams()
    if (q.q) p.set('q', q.q)
    if (q.category) p.set('category', q.category)
    const s = p.toString()
    return json<import('@/modules/phrases/usePhrases').Phrase[]>(`/phrases${s ? `?${s}` : ''}`)
  },

  /** 分类清单（去重、忽略空），给筛选栏用 */
  phraseCategories: () => json<string[]>('/phrases/categories'),

  /** 保存话术；**标题相同即覆盖**（引擎行为），所以不必先查再决定 insert/update */
  createPhrase: (p: { title: string; body: string; category: string }) =>
    json<import('@/modules/phrases/usePhrases').Phrase>('/phrases', {
      method: 'POST',
      body: JSON.stringify(p),
    }),

  patchPhrase: (id: number, p: { title?: string; body?: string; category?: string }) =>
    json<import('@/modules/phrases/usePhrases').Phrase>(`/phrases/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    }),

  removePhrase: (id: number) => json<{ ok: true }>(`/phrases/${id}`, { method: 'DELETE' }),

  /** 记一次使用：发出去的动作就是最好的"常用度"信号 */
  markPhraseUsed: (id: number) =>
    json<import('@/modules/phrases/usePhrases').Phrase>(`/phrases/${id}/use`, { method: 'POST' }),

  // ── 敏感词库（guard 工具的数据源，全局共用一套） ──
  listWords: (q = '', level = '') => json<SensitiveWord[]>(`/sensitive/words?q=${encodeURIComponent(q)}&level=${encodeURIComponent(level)}`),

  addWord: (p: SensitiveWordIn) => json<SensitiveWord>('/sensitive/words', { method: 'POST', body: JSON.stringify(p) }),

  updateWord: (id: number, p: Partial<SensitiveWordIn>) =>
    json<SensitiveWord>(`/sensitive/words/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),

  /** 停用而不是删除：词库一般一次配好长期用，临时不生效不该丢 */
  setWordEnabled: (id: number, enabled: boolean) =>
    json<SensitiveWord>(`/sensitive/words/${id}/enabled?enabled=${enabled}`, { method: 'POST' }),

  removeWord: (id: number) => json<{ ok: true }>(`/sensitive/words/${id}`, { method: 'DELETE' }),

  /** 批量导入：一行一个词，可带危级。返回逐条结果（哪几行没进去） */
  importWords: (text: string) =>
    json<{ added: string[]; skipped: { line: number; word: string; reason: string }[] }>('/sensitive/words/import', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  wordStats: () => json<{ total: number; enabled: number; high: number; mid: number; low: number; disabled: number }>('/sensitive/stats'),

  /** JSON 导入：兼容 ["词"] 与 [{"word":"词","level":"high"}] 两种结构 */
  importWordsJson: (payload: unknown) =>
    json<{ added: string[]; skipped: { line: number; word: string; reason: string }[] }>('/sensitive/words/import-json', {
      method: 'POST',
      body: JSON.stringify({ words: payload }),
    }),

  /** 导出成 studio 的 wordlib.json（供别人在 Studio 里编辑后再分发回来） */
  exportWordsJson: () =>
    fetch(`${apiBase()}/sensitive/export`).then((res) => {
      if (!res.ok) return failWith(res, '导出词库失败')
      return res.json() as Promise<{
        schemaVersion: number
        updatedAt: string
        words: Array<{ id: string; text: string; matchKey: string; category: string; severity: string; matchMode: string; enabled: boolean }>
        categories: Array<{ name: string; description: string }>
      }>
    }),

  /** 当前有窗口的应用：让用户挑一个真实在用的，而不是手填进程名 */
  sensitiveApps: () => json<{ hwnd: number; title: string }[]>('/sensitive/apps'),

  /** 从真实对话文本里提取候选违禁词（手机号 / 微信 / QQ / 外链） */
  wordCandidates: (text: string) =>
    json<{ items: { kind: string; value: string; reason: string }[]; textLen: number }>('/sensitive/candidates', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  // ── wordlib.json 自动同步（主管分发文件 → 坐席端自动导入）──
  getWordlibWatch: () => json<WordlibWatchStatus>('/sensitive/wordlib-watch'),
  /** 配置被监听的文件路径；空串 = 关闭自动同步。返回即时试导后的状态 */
  setWordlibWatch: (path: string) =>
    json<WordlibWatchStatus>('/sensitive/wordlib-watch', { method: 'PUT', body: JSON.stringify({ path }) }),

  // ── 每日违禁词汇总播报（工单 04 · ⑥）──
  /** 汇总配置 + 状态：是否启用、发送时刻、上次发送日期、待补发日期列表 */
  dailySummary: () => json<DailySummaryStatus>('/notify/daily-summary'),
  /** 保存配置：enabled / sendTime / lastSentDate（只合入传入字段） */
  saveDailySummary: (patch: Partial<DailySummaryConfig>) =>
    json<DailySummaryStatus>('/notify/daily-summary', { method: 'PUT', body: JSON.stringify(patch) }),
  /** 手动触发今天的汇总（设置页「立即发送」） */
  sendDailySummary: () => json<{ sent: boolean; reason?: string; date?: string; text?: string }>('/notify/daily-summary/send', { method: 'POST' }),
  /** 手动补发 pending（设置页「重试未发送」） */
  retryDailySummary: () => json<{ retried: number; sent: number; remaining: number }>('/notify/daily-summary/retry', { method: 'POST' }),
}

/** 违禁词危级：决定告警强度与弹窗措辞 */
export type WordLevel = 'high' | 'mid' | 'low'

/** wordlib.json 自动同步的运行状态（path 落库，其余是当场结果） */
export interface WordlibWatchStatus {
  path: string
  lastImportAt: string
  lastResult: { added: string[]; skipped: unknown[] } | null
  lastError: string
}

/** 每日汇总播报的配置（enabled / 发送时刻），可部分更新 */
export interface DailySummaryConfig {
  enabled?: boolean
  sendTime?: string
  lastSentDate?: string
}

/** 每日汇总播报的状态：配置 + 上次发送日期 + 待补发日期列表 */
export interface DailySummaryStatus {
  enabled: boolean
  sendTime: string
  lastSentDate: string
  pending: string[]
}

export interface SensitiveWord {
  id: number
  word: string
  /** 拼音首字母键（tkzc → 退款政策），由引擎按词自动算 */
  matchKey: string
  level: WordLevel
  caseSensitive: boolean
  enabled: boolean
  note: string
  hitCount: number
}

export interface SensitiveWordIn {
  word: string
  level?: WordLevel
  match_key?: string
  case_sensitive?: boolean
  note?: string
}

/**
 * 日志 WebSocket 的完整地址。
 *
 * 抽成纯函数便于单测（jsdom 里连不上真 WS）。**路径必须带 `/api` 前缀** ——
 * 引擎把 ws 路由注册在 api router 上、又挂在 `/api` 之下（`app.mount("/api", api)`），
 * 真实路径是 `/api/ws/instances/{id}/logs`。
 */
export function logStreamUrl(id: string): string {
  const base = resolveEngineOrigin(engineProtocol(), ipc.enginePort())
  const path = `/api/ws/instances/${id}/logs`
  if (base) {
    // file:// 下 location.host 不可用：直连本机引擎，http → ws
    return `${base.replace(/^http/, 'ws')}${path}`
  }
  const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${path}`
}

/** 日志 WebSocket：每实例独立通道 */
export function openLogStream(id: string, onMessage: (line: string) => void): () => void {
  const ws = new WebSocket(logStreamUrl(id))
  ws.onmessage = (e) => onMessage(e.data)
  return () => ws.close()
}
