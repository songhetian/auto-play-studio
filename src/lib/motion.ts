import type { Transition, Variants } from 'motion/react'

/**
 * 动效预设（单一来源）。
 *
 * 桌面工具里的动效用来说明「什么变了」，不是用来表演：
 * 入场一律 160–260ms、位移不超过 10px，重复出现时不会让人等。
 */

/** 页面区块入场：淡入 + 轻微上移 */
export const EASE_OUT: Transition['ease'] = [0.22, 1, 0.36, 1]

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE_OUT } },
}

/** 容器：子项依次入场，间隔 35ms —— 再长就会显得拖 */
export const staggerList: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035, delayChildren: 0.02 } },
}

/** 列表项：比区块更轻，因为会出现很多次 */
export const fadeItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.18, ease: EASE_OUT } },
}

/** 状态点/徽标的切换：只做淡入淡出，不位移，避免在表格里跳动 */
export const fadeOnly: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.16 } },
}

/** 供 motion 直接展开用的 props */
export const fadeUpProps = { variants: fadeUp, initial: 'hidden', animate: 'show' } as const
