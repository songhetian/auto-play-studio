import type { IconName } from '@/components/icon'

/**
 * 弹窗的语义分型。
 *
 * 之前所有弹窗长得一模一样（灰底卡片 + 24px 小图标），于是点「删除实例」
 * 和点「重新索引」看到的是同一种框子，扫一眼分不出"这件事会不会弄丢数据"。
 *
 * 分四类，各自的**视觉重量**不同：
 *  - `danger` 删数据/注销：红色强调带 + 红色主按钮 + 默认拦回车
 *  - `warn`   覆盖/清理：有风险但不删：琥珀强调带 + 提示语气
 *  - `info`   常规确认/说明：品牌色点缀，保持中性
 *  - `form`   表单输入：品牌色，主按钮在右侧
 *
 * 关键取舍：危险类**不只把按钮变红**，而是给整个弹窗一道顶部强调带。
 * 按钮红不红是第二眼的事，第一眼要能分辨"这个框是危险的"。
 */

export type DialogToneId = 'danger' | 'warn' | 'info' | 'form'

export interface DialogTone {
  id: DialogToneId
  /** 一句话标签，作为徽标显示（危险类才显示，中性类不显示避免噪音） */
  label: string
  /** 推荐图标；调用方不传 `icon` 时用它 */
  icon: IconName
  /** 顶部强调带的颜色语义 */
  accent: 'danger' | 'warn' | 'primary' | 'none'
  /** 图标底色语义 */
  iconTone: 'danger' | 'warn' | 'primary' | 'neutral'
  /** 是否拦回车（危险类要拦，防手滑直接删掉） */
  guardEnter: boolean
}

export const DIALOG_TONE: Record<DialogToneId, DialogTone> = {
  danger: {
    id: 'danger',
    label: '危险操作',
    // 用 trash 而不是 warning：删除和"注意"必须一眼能分开，
    // 都用 warning 等于危险类没有独立标识
    icon: 'trash',
    accent: 'danger',
    iconTone: 'danger',
    // 手滑回车 = 删掉数据
    guardEnter: true,
  },
  warn: {
    id: 'warn',
    label: '注意',
    icon: 'warning',
    accent: 'warn',
    iconTone: 'warn',
    guardEnter: false,
  },
  info: {
    id: 'info',
    label: '',
    icon: 'info',
    accent: 'primary',
    iconTone: 'primary',
    guardEnter: false,
  },
  form: {
    id: 'form',
    label: '',
    icon: 'pencil',
    accent: 'primary',
    iconTone: 'primary',
    guardEnter: false,
  },
}

/** 动作 → 语义类型。调用方给动作就行，不用自己判断该不该用红色。 */
const ACTION_TONE: Record<string, DialogToneId> = {
  // 会丢数据
  delete: 'danger',
  remove: 'danger',
  unregister: 'danger',
  destroy: 'danger',
  // 有风险但不删
  overwrite: 'warn',
  clear: 'warn',
  reset: 'warn',
  discard: 'warn',
  // 常规
  apply: 'info',
  stop: 'info',
  confirm: 'info',
  start: 'info',
  reindex: 'info',
  recover: 'info',
  new: 'form',
  edit: 'form',
  save: 'form',
}

/** 解析弹窗语义：显式 `tone` 优先，否则按 `action` 推断；都认不出就是 info。 */
export function dialogToneOf(opts: { action?: string; tone?: DialogToneId }): DialogToneId {
  if (opts.tone) return opts.tone
  if (opts.action && ACTION_TONE[opts.action]) return ACTION_TONE[opts.action]
  // 宁可少一点红色：把"保存"弹成红的比反过来糟得多
  return 'info'
}

export const toneByAction = (action: string): DialogTone => DIALOG_TONE[dialogToneOf({ action })]

/**
 * 弹窗外框类名：顶部一道强调带。
 *
 * ⚠️ 必须是 **Tailwind 字面量** —— JIT 扫源码找类名，拼接出来的规则压根不生成，
 * 表现为「代码写了红色强调，页面上什么都没有」。
 */
const ACCENT_CLASS: Record<DialogToneId, string> = {
  danger: 'border-t-2 border-t-destructive',
  warn: 'border-t-2 border-t-warn',
  info: 'border-t-2 border-t-primary',
  form: 'border-t-2 border-t-primary',
}

export const dialogShellClass = (tone: DialogToneId): string =>
  `${ACCENT_CLASS[tone]} overflow-hidden p-0 gap-0`
