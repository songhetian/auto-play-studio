import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { api } from '@/lib/api'
import type { KbHit, LogiQueryItem } from '@/lib/api'
import { ipc, type PhrasePanelOpen } from '@/lib/ipc'
import { usePhrases } from '@/modules/phrases/usePhrases'
import { buildInsertText, matchRanges, phraseVariables, searchPhrases } from './phraseSearch'
import { suggestPhrases } from './suggestPhrases'
import { enterActionOf, kbFillText, mergeQuick, type PanelMode, type QuickItem } from './quickSearch'
import { parseSelection } from '@/lib/parseSelection'
import { inferVars, applyInferred } from '@/lib/fillVars'
import { buildLogiCsv } from './logiQueryCsv'
import { useAttendantStore } from '@/stores/attendantStore'

/**
 * 话术速查面板（Electron 置顶小窗加载 `#/phrases-quick`）。
 *
 * 客服的工作流：在聊天客户端里按 `Ctrl + Alt + P` → 打几个字 → ↑↓ 选 → Enter，
 * 话术就落进**原来那个输入框**（还焦点 + Ctrl+V 在主进程，见 electron/phraseFocus.ts）。
 *
 * 还有一种入口：在聊天窗口框住客户那句话按 `Ctrl + Alt + S`（选区建议）——
 * 这时主进程把选中的文字当 `seed` 送进来，面板直接列出**按这句话匹配**的话术，
 * 省掉"再想该搜什么词"这一步。一旦开始打字，就切回普通关键词搜索。
 *
 * 本版在原来「话术速查」之上叠了三件事（工单 04 · ①②③）：
 *  ① 统一速查：话术在前、知识库在后，合成一条可 ↑↓ 导航的列表（Enter 分别插话术 / 复制摘要）；
 *  ② 选区查件：从 seed 里抠出运单号，一键调「物流」实例查状态，结果只读 + 复制 CSV（绝不插进聊天框）；
 *  ③ 变量自动填：插入带 {客户名}/{订单号} 的话术时，从句区推断并替掉变量（设置里可关，默认开）。
 *
 * UI 取舍：靛蓝 `#2455D9` 强调色，平面、细线图标、无渐变、无重投影（对齐既有偏好）；
 * 用所选话术时**保留未推断到的 `{变量}` 原样**，并在页脚提醒"记得替换"——
 * 宁可让客服看到占位符，也不要发出「您好，」这种残缺话术，或把错名字发出去。
 *
 * 第四种入口 `Ctrl + Alt + K`（知识库速填）：同一个窗口、同一份列表，换的是**出口**——
 * 知识库命中排到前面，Enter 把内容填进事先框定的客服输入框（走引擎的 assist 链路，
 * 见 python/engine/assist/），而不是插回"唤起前的那个窗口"。
 * 两条出口的差别落在 `enterActionOf`（quickSearch.ts）那张真值表上，这里只负责分发。
 */

/** 强调色（与全局靛蓝一致） */
const ACCENT = '#2455D9'
/** 高亮底色：极浅的靛蓝，不抢正文 */
const MARK_BG = 'rgba(36, 85, 217, 0.14)'

/** 把命中的关键词高亮出来（大小写不敏感、支持多关键词） */
function Highlight({ text, query }: { text: string; query: string }) {
  const ranges = useMemo(() => matchRanges(text, query), [text, query])
  if (!ranges.length) return <>{text}</>

  const out: ReactNode[] = []
  let cursor = 0
  ranges.forEach((r, i) => {
    if (r.start > cursor) out.push(text.slice(cursor, r.start))
    out.push(
      <mark
        key={i}
        style={{ background: MARK_BG, color: ACCENT, borderRadius: 3, padding: '0 1px' }}
      >
        {text.slice(r.start, r.end)}
      </mark>,
    )
    cursor = r.end
  })
  if (cursor < text.length) out.push(text.slice(cursor))
  return <>{out}</>
}

export default function PhraseQuickPanel() {
  const [query, setQuery] = useState('')
  /** 这次是哪个键唤起的：决定排序与 Enter 送哪儿（phrase = 插原窗口，kb = 填框定输入框） */
  const [mode, setMode] = useState<PanelMode>('phrase')
  /** 选区建议带进来的客户消息；非空且 query 为空时走建议模式 */
  const [seed, setSeed] = useState('')
  const [index, setIndex] = useState(0)
  const [hotkey, setHotkey] = useState('')
  /** 填入失败的原因（没框输入框 / 屏幕被占 / 引擎连不上），显示在页脚上方 */
  const [fillError, setFillError] = useState('')
  /** 知识库命中（异步，不挡话术同步） */
  const [kb, setKb] = useState<KbHit[]>([])
  const [kbLoading, setKbLoading] = useState(false)
  /** 第一个「物流」实例：一键查件的目标（没有就提示先建实例） */
  const [logiId, setLogiId] = useState<string | null>(null)
  const [logiItems, setLogiItems] = useState<LogiQueryItem[] | null>(null)
  const [logiLoading, setLogiLoading] = useState(false)
  const [logiError, setLogiError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const autoFillVars = useAttendantStore((s) => s.autoFillVars)
  const { data, isLoading, refetch } = usePhrases('', '')
  const phrases = data ?? []
  /** 正在按选中内容推荐（还没开始打字） */
  const suggesting = !!seed && !query
  const results = useMemo(
    () => {
      const phraseList = suggesting ? suggestPhrases(seed, phrases) : searchPhrases(phrases, query, 50)
      // kb 模式是冲知识库去的：把它排前面，省掉先滚过一屏话术
      return mergeQuick(phraseList, kb, mode === 'kb')
    },
    [suggesting, seed, phrases, query, kb, mode],
  )
  const selected = results[index]

  /** 高亮词：搜索模式用 query，建议模式用 seed（整句也能逐词高亮） */
  const hl = query || seed

  /** 从选区里抠出的运单号（② 一键查件的数据源） */
  const seedWaybills = useMemo(() => (seed ? parseSelection(seed).waybills : []), [seed])

  // 透明底：styles.css 给 body 设了不透明背景，这里覆盖，否则窗口会是一个方块
  useEffect(() => {
    const html = document.documentElement
    const prev = { h: html.style.background, b: document.body.style.background, o: document.body.style.overflow }
    html.style.background = 'transparent'
    document.body.style.background = 'transparent'
    document.body.style.overflow = 'hidden'
    return () => {
      html.style.background = prev.h
      document.body.style.background = prev.b
      document.body.style.overflow = prev.o
    }
  }, [])

  // 每唤起一次就重置：清空查询、选中回第一条、拉最新话术/实例、清查件状态并聚焦输入框
  useEffect(() => {
    const reset = (payload: PhrasePanelOpen = {}) => {
      // 老版本主进程不发 `mode`，缺省按「话术速查」处理，不能因此把面板弄成空白
      const next: PanelMode = payload?.mode === 'kb' ? 'kb' : 'phrase'
      setMode(next)
      setSeed(payload?.seed ?? '')
      setQuery('')
      setIndex(0)
      setKb([])
      setKbLoading(false)
      setFillError('')
      setLogiItems(null)
      setLogiError('')
      setLogiLoading(false)
      void refetch()
      // 页脚键名跟着入口走：按 K 唤起来却显示 P，客服会以为自己按错了
      void (next === 'kb' ? ipc.kbPanelHotkey() : ipc.phraseHotkey()).then(setHotkey)
      // 找第一个「物流」实例当查件目标；没有也不影响话术/知识库
      api.listInstances().then((list) => setLogiId(list.find((i) => i.tool === 'logi')?.id ?? null)).catch(() => setLogiId(null))
      requestAnimationFrame(() => inputRef.current?.focus())
    }
    const off = ipc.onPhrasePanelOpen(reset)
    void ipc.phraseHotkey().then(setHotkey)
    inputRef.current?.focus()
    return off
    // refetch 来自 react-query，引用稳定；这里只在挂载时订阅一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 知识库异步检索（防抖）：不挡话术同步展示，引擎不可达静默降级为空
  const kbQuery = query.trim() || (suggesting ? seed.trim() : '')
  useEffect(() => {
    if (!kbQuery) {
      setKb([])
      setKbLoading(false)
      return
    }
    let cancelled = false
    setKbLoading(true)
    const t = setTimeout(() => {
      api
        .kbSearch(kbQuery, 10)
        .then((res) => !cancelled && setKb(res.results))
        .catch(() => !cancelled && setKb([]))
        .finally(() => !cancelled && setKbLoading(false))
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [kbQuery])

  // 结果变少时把选中项夹回范围内，避免"选中了一条不存在的"
  useEffect(() => {
    setIndex((i) => (i >= results.length ? 0 : i))
  }, [results.length])

  // 键盘移动选中项时让它保持可见
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  /**
   * 一条命中最终要送出去的文本。
   *
   * 话术要过一遍变量自动填（③）：从句区推断 `{客户名}` / `{订单号}`，推断不出的原样保留；
   * 知识库走 `kbFillText`（片段拼起来，拼出来是空的就退回文件名）。
   */
  const textOf = (item: QuickItem): string => {
    if (item.kind === 'kb') return item.kb ? kbFillText(item.kb) : ''
    const p = item.phrase
    if (!p) return ''
    let body = p.body
    if (autoFillVars && seed) {
      const vals = inferVars(p.body, seed)
      if (Object.keys(vals).length) body = applyInferred(p.body, vals)
    }
    return buildInsertText({ ...p, body })
  }

  /**
   * kb 模式的出口：把文本填进框定的客服输入框（**只填不发送**）。
   *
   * 失败时**不关面板**：多半是"还没框过输入框"或"屏幕被某个实例占着"，
   * 客服得看着这句提示去改配置或停实例 —— 把面板一关，线索也跟着没了。
   */
  const fillInto = async (text: string) => {
    if (!text) return
    try {
      await api.assistFill(text)
      await ipc.closePhrasePanel()
    } catch (e) {
      setFillError(e instanceof Error ? e.message : '填入失败')
    }
  }

  /** 选中一条：按 `enterActionOf` 的真值表决定插回原窗口 / 只复制 / 填入输入框 */
  const activate = async (item: QuickItem) => {
    const action = enterActionOf(mode, item.kind)
    // 用过了就记一笔（kb 命中没有 id，自然跳过）
    if (item.phrase) void api.markPhraseUsed(item.phrase.id).catch(() => {})
    if (action === 'copy') {
      if (item.kb) ipc.copyText(kbFillText(item.kb))
      return
    }
    if (action === 'insert') {
      await ipc.insertPhrase(textOf(item))
      return
    }
    await fillInto(textOf(item))
  }

  const onEnter = async () => {
    const sel = results[index]
    if (sel) await activate(sel)
  }

  /** 改查询词一律走这里：顺带清掉上一次的填入报错 —— 内容都换了，旧报错不再有意义 */
  const changeQuery = (v: string) => {
    setQuery(v)
    setIndex(0)
    setFillError('')
  }

  /** ② 一键查件：调物流实例，结果只读，绝不插进聊天框 */
  const queryWaybill = async () => {
    if (!logiId || !seedWaybills.length) return
    setLogiLoading(true)
    setLogiError('')
    setLogiItems(null)
    try {
      const res = await api.logiQuery(logiId, seedWaybills.join(' '))
      setLogiItems(res.items)
    } catch (e) {
      setLogiError(e instanceof Error ? e.message : '查询失败')
    } finally {
      setLogiLoading(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      void ipc.closePhrasePanel()
      return
    }
    if (!results.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => (i + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => (i - 1 + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void onEnter()
    }
  }

  // 页脚提示：先看选中项是什么
  const phraseVars = selected?.kind === 'phrase' && selected.phrase ? phraseVariables(selected.phrase) : []
  const filledVars =
    selected?.kind === 'phrase' && selected.phrase && autoFillVars && seed
      ? inferVars(selected.phrase.body, seed)
      : {}
  const remainingVars = phraseVars.filter((v) => !Object.prototype.hasOwnProperty.call(filledVars, v))

  return (
    <div className="w-screen h-screen bg-transparent p-2 select-none" onKeyDown={onKeyDown}>
      <div
        className="h-full flex flex-col rounded-xl bg-surf border border-gray-3 overflow-hidden"
        style={{ boxShadow: '0 10px 30px rgba(17, 24, 39, 0.16)' }}
      >
        {/* 搜索头 */}
        <div className="flex-none flex items-center gap-2 px-3 h-11 border-b border-gray-3">
          <Search size={16} strokeWidth={1.6} className="text-gray-5 flex-none" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            placeholder={
              mode === 'kb'
                ? '搜知识库，选中后填进客服输入框…'
                : '输入关键词，快速找话术 / 知识库…'
            }
            className="flex-1 min-w-0 bg-transparent outline-none text-sm text-gray-9 placeholder:text-gray-5"
          />
          {kbLoading && <span className="flex-none text-xs text-gray-5">知识库检索中…</span>}
          {query && (
            <button
              type="button"
              className="flex-none text-xs text-gray-5 hover:text-gray-7"
              style={{ fontWeight: 400 }}
              onClick={() => {
                changeQuery('')
                inputRef.current?.focus()
              }}
            >
              清空
            </button>
          )}
        </div>

        {/* 建议模式提示条：说清"这些候选是按你框住的那句话挑的"，并提供回到手动搜索的出口 */}
        {suggesting && (
          <div
            className="flex-none flex items-center gap-2 px-3 h-8 border-b border-gray-3 text-xs"
            style={{ color: ACCENT }}
          >
            <span className="truncate">按选中内容推荐：{seed}</span>
            <div className="flex-1" />
            <button
              type="button"
              className="flex-none text-gray-5 hover:text-gray-7"
              style={{ fontWeight: 400 }}
              onClick={() => {
                setSeed('')
                changeQuery('')
                inputRef.current?.focus()
              }}
            >
              手动搜索
            </button>
          </div>
        )}

        {/* ② 选区查件条：从 seed 抠到运单号才出现 */}
        {seedWaybills.length > 0 && (
          <div className="flex-none px-3 py-2 border-b border-gray-3 bg-gray-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-6">选区运单：</span>
              <span className="font-mono text-gray-9">{seedWaybills.join('、')}</span>
              <div className="flex-1" />
              {logiId ? (
                <button
                  type="button"
                  disabled={logiLoading}
                  onClick={() => void queryWaybill()}
                  className="flex-none rounded-md bg-[var(--c-brand-600,#2455D9)] px-2.5 py-1 text-white disabled:opacity-60"
                  style={{ fontWeight: 400 }}
                >
                  {logiLoading ? '查询中…' : '一键查件'}
                </button>
              ) : (
                <span className="flex-none text-gray-5">需先在控制台创建「物流」实例</span>
              )}
            </div>
            {logiError && <div className="mt-1 text-xs text-red-600">查件失败：{logiError}</div>}
            {logiItems && (
              <div className="mt-2 space-y-1.5">
                {logiItems.map((it) => (
                  <div
                    key={it.no}
                    className="flex items-center gap-2 rounded-md border border-gray-3 bg-surf px-2 py-1.5 text-xs"
                  >
                    <span className="font-mono text-gray-9 flex-none">{it.no}</span>
                    <span className="text-gray-6 flex-none">{it.company}</span>
                    <span className={`flex-none ${it.ok ? 'text-gray-9' : 'text-red-600'}`}>{it.status || '—'}</span>
                    <span className="text-gray-5 truncate flex-1">{it.trace}</span>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => ipc.copyText(buildLogiCsv(logiItems))}
                  className="flex-none rounded-md border border-gray-3 px-2 py-1 text-gray-7 hover:text-gray-9"
                  style={{ fontWeight: 400 }}
                >
                  复制 CSV
                </button>
              </div>
            )}
          </div>
        )}

        {/* 候选列表 */}
        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto">
          {isLoading ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-5">正在加载话术…</div>
          ) : results.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-5 px-6 text-center">
              {suggesting
                ? '没找到与这句相关的话术/知识库，点「手动搜索」换个说法'
                : query
                  ? '没有匹配的话术或知识库，换个关键词试试'
                  : '话术库还是空的，先到「话术库」页面添加几条'}
            </div>
          ) : (
            results.map((item, i) => {
              const active = i === index
              return (
                <div
                  key={item.key}
                  data-idx={i}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => void activate(item)}
                  className="px-3 py-2 cursor-pointer flex items-start gap-3"
                  style={{
                    background: active ? 'rgba(36, 85, 217, 0.07)' : undefined,
                    borderLeft: `3px solid ${active ? ACCENT : 'transparent'}`,
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-9 truncate">
                        <Highlight text={item.title} query={hl} />
                      </span>
                      {item.kind === 'kb' ? (
                        <span className="flex-none text-xs text-gray-5 border border-gray-3 rounded px-1.5 leading-5">
                          知识库
                        </span>
                      ) : item.phrase?.category ? (
                        <span className="flex-none text-xs text-gray-5 border border-gray-3 rounded px-1.5 leading-5">
                          {item.phrase.category}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-gray-6 mt-0.5 line-clamp-2 whitespace-pre-wrap break-all">
                      <Highlight text={item.preview} query={hl} />
                    </div>
                  </div>
                  {item.kind === 'phrase' && item.phrase && item.phrase.usedCount > 0 && (
                    <span className="flex-none text-xs text-gray-5 mt-0.5">用过 {item.phrase.usedCount}</span>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* 填入失败：说清为什么、下一步做什么。面板不关 —— 关了就看不到这句了 */}
        {fillError && (
          <div className="flex-none px-3 py-2 text-xs border-t border-gray-3" style={{ color: '#C0392B' }}>
            没填进去：{fillError}
          </div>
        )}

        {/* 页脚：变量提醒优先（送出去之前真正要看的），其次说明 Enter 会做什么 */}
        <div className="flex-none h-9 flex items-center px-3 gap-3 text-xs text-gray-5 border-t border-gray-3">
          {phraseVars.length > 0 ? (
            <span style={{ color: ACCENT }} className="truncate">
              {Object.keys(filledVars).length > 0 && (
                <span>已自动填入 {Object.entries(filledVars).map(([k, v]) => `${k}=${v}`).join(' ')}；</span>
              )}
              {remainingVars.length > 0
                ? `仍需手动替换 ${remainingVars.map((v) => `{${v}}`).join(' ')}`
                : '变量已全部填好'}
            </span>
          ) : mode === 'kb' ? (
            <span style={{ color: ACCENT }} className="truncate">
              Enter 填入客服输入框 —— 只填不发送，发出与否你自己按回车
            </span>
          ) : selected?.kind === 'kb' ? (
            <span style={{ color: ACCENT }} className="truncate">
              Enter 复制摘要到剪贴板（不插入聊天框）
            </span>
          ) : (
            <span>↑↓ 选择 · Enter 插入 · Esc 关闭</span>
          )}
          <div className="flex-1" />
          {hotkey && <span className="flex-none">唤起键 {hotkey}</span>}
        </div>
      </div>
    </div>
  )
}
