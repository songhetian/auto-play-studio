/**
 * 主题解析纯逻辑：与 DOM、store 无关，单独放出来好测。
 *
 * 三种用户选择：
 *  - `light`  ：始终浅色
 *  - `dark`   ：始终深色
 *  - `system` ：跟随操作系统的 prefers-color-scheme
 *
 * 解析结果只有 light / dark 两种，落在 <html data-theme> 上供 CSS 令牌切换。
 */

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

/** 用户可见的模式顺序，循环切换与设置页都按它来 */
export const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system']

export const THEME_LABEL: Record<ThemeMode, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
}

/** 把用户选择 + 系统偏好折叠成一个确定主题 */
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light'
  return mode
}

/** 模式轮换：浅色 → 深色 → 跟随系统 → 浅色…… */
export function nextMode(mode: ThemeMode): ThemeMode {
  const i = THEME_MODES.indexOf(mode)
  return THEME_MODES[(i + 1) % THEME_MODES.length]
}

let animTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 把主题写到 <html data-theme>。
 *
 * `animate` 只在用户主动切换时为 true：给根节点挂一小会儿 .theme-anim，
 * 让整站底色/描边有个 180ms 过渡，避免硬闪；首屏应用不需要动画。
 */
export function applyTheme(theme: ResolvedTheme, animate = false): void {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  if (animate) {
    el.classList.add('theme-anim')
    if (animTimer) clearTimeout(animTimer)
    animTimer = setTimeout(() => el.classList.remove('theme-anim'), 220)
  }
  el.dataset.theme = theme
}

/** 当前系统是否为深色；非浏览器环境（SSR / 测试）一律当浅色 */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}
