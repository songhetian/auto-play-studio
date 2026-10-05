/**
 * 提醒框按功能分型（纯函数，可测）。
 *
 * 为什么必须分：现在所有提醒都是同一套红框 + 感叹号。
 * 用户看到"敏感词命中"和"画面里出现目标"长得一样，分不清该去改话术还是去看屏幕。
 *
 * 两条原则：
 * 1. **语气跟着级别走**：alert 才用最强色；warn 更轻；info 不响不久留。
 *    全部用最重的样式等于没有强调 —— 用户会整体忽略。
 * 2. **认不出来的回落到中性**：宁可弱一点，也不要把"不知道是什么"渲染成红色，
 *    红色一多就等于没红色。
 */

/** 强调色档位：语义 token 后缀，界面据此取类名 */
export type AlertAccent = 'destructive' | 'warning' | 'info' | 'neutral'

export interface AlertStyle {
  /** 强调色档位 */
  accent: AlertAccent
  /** 图标：一眼区分"画面"与"文字" */
  icon: string
  /** 人话标题：发生了什么 */
  title: string
  /** 是否发声 */
  sound: boolean
  /** 停留时长（毫秒）：轻的等级不该霸占视线 */
  durationMs: number
  /**
   * 醒目强度 0~2。
   *
   * 为什么与颜色分开：颜色表达**级别**（红=最重），强度表达"这件事多急"。
   * 两件事混在一个字段里就会出现"敏感词的 alert 也是红色 → 撞色"的死结。
   */
  intensity: number
  /** 业务语气标签：同一级别下区分"这是哪一类事" */
  tone: string
  /**
   * 左侧色条的颜色类：按**功能类型**取色，与上方 level→accent 正交。
   *
   * 颜色留给级别（红=最重），但"哪一类事"还得一眼分得出来 ——
   * 画面监控、敏感词、图片识别、视频帧、意图定位各给一种色条，
   * 即使同为 alert 红框，色条也让人秒懂这是"画面里出现目标"还是"客服打错话"。
   */
  bar: string
}

interface HitLike {
  tool: string
  level: string
  matchedBy: string
}

/** 各工具的一句话：它到底在盯什么。`tone` 是业务语气标签，`bar` 是左侧色条色，都与颜色正交。 */
const TOOL_PURPOSE: Record<string, { title: string; icon: string; tone: string; bar: string }> = {
  // 画面里出现了目标：突发事件
  monitor: { title: '图片监控命中', icon: 'monitor', tone: '画面目标出现', bar: 'bg-sky-500' },
  // 客服打了不该说的词：行为问题，要去改话术/复核
  guard: { title: '敏感词命中', icon: 'shield', tone: '话里有违禁词', bar: 'bg-destructive' },
  // 单张图片识别命中（模板/OCR）
  image: { title: '图片识别命中', icon: 'camera', tone: '画面出现目标', bar: 'bg-emerald-500' },
  // 视频帧识别命中
  video: { title: '视频帧命中', icon: 'video', tone: '视频里出现目标', bar: 'bg-violet-500' },
  // 基于意图快速定位到的画面（"检查是否遗漏配件"→相关帧）
  intent: { title: '意图定位结果', icon: 'target', tone: '按意图找到画面', bar: 'bg-amber-500' },
}

/** 不认识的告警工具：中性色条（回落，不能变红） */
const NEUTRAL_BAR = 'bg-muted-foreground/40'

const ACCENT_CLS: Record<AlertAccent, string> = {
  destructive: 'border-destructive/70',
  warning: 'border-warn',
  info: 'border-primary/50',
  neutral: 'border-border',
}

export function alertStyleOf(hit: HitLike): AlertStyle {
  const purpose = TOOL_PURPOSE[hit.tool]
  const tone = purpose?.tone ?? '系统提示'

  // info：不动声色，不响不久留
  if (hit.level === 'info') {
    return {
      // 认不出的工具一律中性：不知道是什么就别染色
      accent: purpose ? 'info' : 'neutral',
      icon: purpose?.icon ?? 'bell',
      title: purpose?.title ?? '系统提示',
      sound: false,
      durationMs: 4000,
      intensity: 0,
      tone,
      bar: purpose?.bar ?? NEUTRAL_BAR,
    }
  }

  // warn：需要留意但不惊慌
  if (hit.level === 'warn') {
    return {
      accent: 'warning',
      icon: purpose?.icon ?? 'warning',
      title: purpose?.title ?? '需要留意',
      sound: true,
      durationMs: 5000,
      intensity: 1,
      tone,
      bar: purpose?.bar ?? NEUTRAL_BAR,
    }
  }

  // alert 及以上：最强色 + 最强强度。认不出的工具回落到中性而不是变红 ——
  // 红色一多就等于没红色
  return {
    accent: purpose ? 'destructive' : 'neutral',
    icon: purpose?.icon ?? 'warning',
    title: purpose?.title ?? '命中提醒',
    sound: true,
    durationMs: 7000,
    intensity: 2,
    tone,
    bar: purpose?.bar ?? NEUTRAL_BAR,
  }
}

/** 强调色 → 完整类名（徽标底色 + 边框），供界面直接用 */
export function accentClassOf(accent: AlertAccent): { badge: string; border: string } {
  switch (accent) {
    case 'destructive':
      return { badge: 'bg-destructive/12 text-destructive', border: ACCENT_CLS.destructive }
    case 'warning':
      return { badge: 'bg-warn/14 text-warn', border: ACCENT_CLS.warning }
    case 'info':
      return { badge: 'bg-primary/10 text-primary', border: ACCENT_CLS.info }
    default:
      return { badge: 'bg-muted text-muted-foreground', border: ACCENT_CLS.neutral }
  }
}

/**
 * 系统通知的文案（三层共用）。
 *
 * 为什么必须从 `alertStyleOf` 取标题，而不是各写一套：
 * 同一次命中会在三层里各出现一次（系统 Toast、右下横幅、模态弹窗），
 * 三处说三句话的话，用户会以为是三件不同的事。标题与横幅层**逐字相同**，
 * 这是"看起来是同一个产品"最便宜也最有效的一条。
 *
 * 正文用「语气标签 + 命中原文」：语气标签说明这是哪一类事（来自同一个真源），
 * 原文带上具体内容，不在通知里重新组织语言（系统通知长度有限，说清楚最重要）。
 */
export interface NotificationText {
  title: string
  body: string
  /** 系统通知图标标识（webhook / 外部通道据此选图标） */
  icon: string
}

export function notificationTextOf(hit: HitLike & { title?: string; detail?: string }): NotificationText {
  const style = alertStyleOf(hit)
  const raw = [hit.title, hit.detail].filter((s) => s && s.trim()).join(' · ')
  // 没有原文时不留空白正文：空通知在 Windows 上只显示标题，像坏了
  const body = raw ? `${style.tone}：${raw}` : style.tone
  return { title: style.title, body, icon: style.icon }
}