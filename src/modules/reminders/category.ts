import type { IconName } from '@/components/icon'
import type { ReminderCategory } from '@/lib/reminderTime'

/**
 * 提醒分类的展示元数据（页面与弹窗共用的单一真源）。
 *
 * 颜色一律取项目既有令牌（primary / ok / warn / destructive + 浅底），
 * 不引入新色板 —— 否则提醒页会和工具箱其余部分看起来像两个软件。
 */

export const CATEGORY_LIST = ['work', 'logistics', 'service', 'personal'] as const

export interface CategoryMeta {
  /** 中文名，填表与弹窗都用它 */
  label: string
  icon: IconName
  /** 弹窗顶部色条 */
  bar: string
  /** 图标环 */
  ring: string
  /** 图标底色 */
  bg: string
  /** 图标前景色 */
  fg: string
  /** 列表左侧色条 */
  side: string
}

export const CATEGORY_META: Record<ReminderCategory, CategoryMeta> = {
  work: {
    label: '工作',
    icon: 'fileText',
    bar: 'bg-primary',
    ring: 'ring-primary/25',
    bg: 'bg-primary/10',
    fg: 'text-primary',
    side: 'bg-primary',
  },
  logistics: {
    label: '物流',
    icon: 'logi',
    bar: 'bg-ok',
    ring: 'ring-ok/25',
    bg: 'bg-ok/12',
    fg: 'text-ok',
    side: 'bg-ok',
  },
  service: {
    label: '客服',
    icon: 'tag',
    bar: 'bg-warn',
    ring: 'ring-warn/30',
    bg: 'bg-warn/14',
    fg: 'text-warn',
    side: 'bg-warn',
  },
  personal: {
    label: '个人',
    icon: 'clock',
    bar: 'bg-muted-foreground/50',
    ring: 'ring-border',
    bg: 'bg-muted',
    fg: 'text-muted-foreground',
    side: 'bg-muted-foreground/40',
  },
}

export function categoryMeta(c: ReminderCategory): CategoryMeta {
  return CATEGORY_META[c] ?? CATEGORY_META.personal
}
