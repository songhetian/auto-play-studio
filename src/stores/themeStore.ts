import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { applyTheme, nextMode, resolveTheme, systemPrefersDark } from '@/lib/theme'
import type { ResolvedTheme, ThemeMode } from '@/lib/theme'

interface ThemeState {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  /** 循环切换，给导航底部的快捷按钮用 */
  cycle: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'system',
      setMode: (mode) => set({ mode }),
      cycle: () => set({ mode: nextMode(get().mode) }),
    }),
    { name: 'autoplay.theme' },
  ),
)

/** 系统偏好深色？mode !== 'system' 时不必订阅媒体查询 */
export function useResolvedTheme(): ResolvedTheme {
  const mode = useThemeStore((s) => s.mode)
  const [sysDark, setSysDark] = useState(systemPrefersDark)

  useEffect(() => {
    if (mode !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSysDark(e.matches)
    setSysDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mode])

  return resolveTheme(mode, sysDark)
}

/**
 * 把当前主题同步到 <html data-theme>。
 * 挂在 AppShell 上（实例窗口也挂），保证两个窗口的主题始终一致。
 */
export function useThemeEffect(): void {
  const resolved = useResolvedTheme()
  const first = useRef(true)
  useEffect(() => {
    // 首屏不加过渡，避免打开应用时整屏从浅色渐变到深色
    applyTheme(resolved, !first.current)
    first.current = false
  }, [resolved])
}
