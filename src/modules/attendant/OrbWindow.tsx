import { useEffect, useRef, useState } from 'react'
import { ipc } from '@/lib/ipc'
import { api } from '@/lib/api'
import { timeoutPendingCount } from '@/lib/hitEvents'
import { OrbStateMachine, type OrbState } from './orbState'

/**
 * 悬浮球窗口的内容（Electron 置顶透明小窗加载 `#/orb`）。
 *
 * 视觉目标（对齐 desk 桌面端形态，也照顾既有偏好）：
 *  - 靛蓝玻璃球：左上打光 + 中心高饱和 + 右下暗部，内置高光点做出体积感；
 *  - **不加外投影**：常亮阴影会显得球"飘"在那儿（明确不喜欢的做法）；
 *  - 四态颜色**交叉淡入淡出**（不是硬切）：常态靛蓝呼吸 / 告警红脉冲 /
 *    待处理深靛蓝常驻（带条数角标）/ 离线灰；
 *  - 文字居中标状态（监控·告警·待处理·离线），白色 + 细描边保证在任何底色上都清晰。
 *
 * 状态由 `OrbStateMachine` 计算，单位时钟用 `Date.now()`，
 * 以 120ms 轮询刷新（告警 3 秒到点后自动回常态，无需定时器精确对齐）。
 * 待处理条数另走一条低频轮询：查最近命中里"超时未确认"的有几条。
 */

/** 拖动判定阈值（px）：小于它算"点击"，大于它才算"拖动"，避免手抖误触 */
const DRAG_THRESHOLD = 4
/** 球体直径（px）。窗口比它大一圈，留出告警光晕扩散空间 */
const BALL = 60
/** 待处理轮询间隔：告警响应时限是 5 分钟，30 秒的粒度足够，不必更密 */
const PENDING_POLL_MS = 30_000
/** 一次统计最多看多少条最近命中：只在"最近的告警"里找漏看的，不必翻历史 */
const PENDING_SCAN_LIMIT = 200
/** 强调色（与全局靛蓝一致），用于待处理角标 */
const ACCENT = '#2455D9'

const LABEL: Record<OrbState, string> = {
  normal: '监控',
  alert: '告警',
  pending: '待处理',
  offline: '离线',
}

/** 每态的三段渐变（玻璃球配色）：左上高光 → 主色 → 右下暗部 */
const GRADIENT: Record<OrbState, string> = {
  normal: 'radial-gradient(circle at 33% 27%, #8FB2FF 0%, #2C5BE0 46%, #12308C 100%)',
  // 待处理比常态更深更实：都是靛蓝，但深一档才看得出"有事没结"
  pending: 'radial-gradient(circle at 33% 27%, #7FA0FF 0%, #1E46C8 46%, #0B2270 100%)',
  alert: 'radial-gradient(circle at 33% 27%, #FFA79A 0%, #E23B2E 46%, #8C1A12 100%)',
  offline: 'radial-gradient(circle at 33% 27%, #E2E5EC 0%, #9AA2B1 46%, #6B7280 100%)',
}
/** 告警光晕的颜色 */
const HALO: Record<OrbState, string> = {
  normal: 'rgba(120,160,255,0.55)',
  pending: 'rgba(36,85,217,0.75)',
  alert: 'rgba(255,110,90,0.6)',
  offline: 'rgba(160,166,180,0.5)',
}

export default function OrbWindow() {
  const machine = useRef(new OrbStateMachine())
  const [state, setState] = useState<OrbState>('normal')
  /** 待处理条数（角标显示）。单独一份 state：低频轮询更新它，与 120ms 的状态轮询节奏不同 */
  const [pendingCount, setPendingCount] = useState(0)

  // 拖动状态：用 ref 存（鼠标事件在 window 上，不能依赖 React 重渲染）
  const dragging = useRef(false)
  const moved = useRef(false)
  const start = useRef({ x: 0, y: 0 })

  // 透明底：styles.css 给 body 设了不透明背景，这里覆盖，否则窗口会是一个方块
  useEffect(() => {
    const html = document.documentElement
    const prevHtml = html.style.background
    const prevBody = document.body.style.background
    const prevOverflow = document.body.style.overflow
    html.style.background = 'transparent'
    document.body.style.background = 'transparent'
    document.body.style.overflow = 'hidden'
    return () => {
      html.style.background = prevHtml
      document.body.style.background = prevBody
      document.body.style.overflow = prevOverflow
    }
  }, [])

  // 订阅主进程事件 + 轮询状态
  useEffect(() => {
    const m = machine.current
    const offPulse = ipc.onOrbPulse(() => {
      m.pulseAlert(Date.now())
      setState(m.currentState(Date.now())) // 立即亮，不等下一轮轮询
    })
    const offOnline = ipc.onOrbOnline((online) => {
      m.setOnline(online)
      setState(m.currentState(Date.now()))
    })
    // 推流只报变化：挂载时补问一次当前在线态，避免晚加载漏掉
    void ipc.orbState().then(({ online }) => {
      m.setOnline(online)
      setState(m.currentState(Date.now()))
    })

    const timer = window.setInterval(() => {
      const s = m.currentState(Date.now())
      setState((prev) => (prev === s ? prev : s))
    }, 120)
    return () => {
      offPulse()
      offOnline()
      window.clearInterval(timer)
    }
  }, [])

  // 待处理轮询：数最近命中里"未确认且已超时"的有几条，喂给状态机做角标。
  // 引擎不可达时静默 —— 球该显示"离线"由在线态那条通道去报，这里不能抢着改状态。
  useEffect(() => {
    let stopped = false
    const tick = async () => {
      try {
        const events = await api.hitEvents({ limit: PENDING_SCAN_LIMIT })
        if (stopped) return
        const m = machine.current
        m.setPending(timeoutPendingCount(events, Date.now()))
        setPendingCount(m.pending())
      } catch {
        /* 离线优先：连不上时保持现状，等在线态通道把球切到"离线" */
      }
    }
    void tick()
    const timer = window.setInterval(tick, PENDING_POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [])

  // 拖动 / 点击 / 右键：监听挂在 window 上，指针移出球也能继续拖
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      if (!moved.current) {
        const d = Math.hypot(e.screenX - start.current.x, e.screenY - start.current.y)
        if (d >= DRAG_THRESHOLD) moved.current = true
      }
      if (moved.current) ipc.orbDragMove(e.screenX, e.screenY)
    }
    const onUp = () => {
      if (!dragging.current) return
      ipc.orbDragEnd()
      const wasMoved = moved.current
      dragging.current = false
      moved.current = false
      // 没拖动 = 一次点击 → 回到控制台
      if (!wasMoved) void ipc.orbActivate()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    dragging.current = true
    moved.current = false
    start.current = { x: e.screenX, y: e.screenY }
    ipc.orbDragStart(e.screenX, e.screenY)
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    ipc.orbMenu()
  }

  const animation =
    state === 'alert'
      ? 'orb-pulse 0.75s ease-in-out infinite'
      : state === 'normal'
        ? 'orb-breathe 2.6s ease-in-out infinite'
        : state === 'pending'
          ? // 待处理是常驻提醒，不是催促：呼吸放慢，别让人被一个"待办"晃得心慌
            'orb-breathe 3.6s ease-in-out infinite'
          : 'none'

  return (
    <div className="w-screen h-screen flex items-center justify-center bg-transparent select-none">
      <div
        onMouseDown={onMouseDown}
        onContextMenu={onContextMenu}
        title={
          pendingCount > 0
            ? `AutoPlay 监控 · 有 ${pendingCount} 条告警待确认 · 单击打开控制台，可拖动`
            : 'AutoPlay 监控 · 单击打开控制台，可拖动'
        }
        style={{
          position: 'relative',
          width: BALL,
          height: BALL,
          borderRadius: '50%',
          cursor: 'grab',
          animation,
        }}
      >
        {/* 告警光晕：只在告警态出现，由内向外扩散后淡出（不是常驻投影） */}
        {state === 'alert' && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              border: `2px solid ${HALO.alert}`,
              animation: 'orb-halo 0.9s ease-out infinite',
            }}
          />
        )}

        {/* 待处理圈：静环、不闪 —— 表示"还挂着事"，与告警的扩散光晕区分开 */}
        {state === 'pending' && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              inset: -4,
              borderRadius: '50%',
              border: `2px solid ${HALO.pending}`,
            }}
          />
        )}

        {/* 四层渐变叠放做颜色交叉淡入淡出：硬切会显得廉价 */}
        {(['normal', 'pending', 'alert', 'offline'] as OrbState[]).map((s) => (
          <span
            key={s}
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              background: GRADIENT[s],
              opacity: state === s ? 1 : 0,
              transition: 'opacity 0.28s ease',
              // 内阴影而非外阴影：做出球面的体积感，又不会在桌面留一片投影
              boxShadow: 'inset 0 2px 5px rgba(255,255,255,0.5), inset 0 -9px 16px rgba(0,0,0,0.35)',
            }}
          />
        ))}

        {/* 高光点：左上角一枚柔和亮斑，玻璃质感的关键 */}
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: '17%',
            top: '13%',
            width: '30%',
            height: '24%',
            borderRadius: '50%',
            background: 'radial-gradient(closest-side, rgba(255,255,255,0.95), rgba(255,255,255,0))',
            transform: 'rotate(-18deg)',
            pointerEvents: 'none',
          }}
        />

        {/* 状态文字：白色 + 极轻的暗描边，保证在任何底色上都清晰 */}
        <span
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#FFFFFF',
            fontFamily: '"Microsoft YaHei UI","Microsoft YaHei",sans-serif',
            fontSize: 13,
            fontWeight: 400,
            letterSpacing: 1,
            textShadow: '0 1px 2px rgba(0,0,0,0.45)',
            pointerEvents: 'none',
          }}
        >
          {LABEL[state]}
        </span>

        {/*
          待处理条数角标：白底 + 靛蓝描边，任何球色上都读得清。
          离线时不显示 —— 那时轮询也停了，数字是旧值，摆出来等于骗人。
        */}
        {pendingCount > 0 && state !== 'offline' && (
          <span
            style={{
              position: 'absolute',
              top: -6,
              right: -6,
              minWidth: 20,
              height: 20,
              padding: '0 5px',
              boxSizing: 'border-box',
              borderRadius: 999,
              background: '#FFFFFF',
              border: `1px solid ${ACCENT}`,
              color: ACCENT,
              fontFamily: '"Microsoft YaHei UI","Microsoft YaHei",sans-serif',
              fontSize: 12,
              fontWeight: 400,
              lineHeight: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            {pendingCount > 99 ? '99+' : pendingCount}
          </span>
        )}
      </div>
    </div>
  )
}