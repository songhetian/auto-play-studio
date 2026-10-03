import { describe, expect, it } from 'vitest'
import { applyTheme, nextMode, resolveTheme, systemPrefersDark } from '@/lib/theme'

/**
 * 期望值来自设计约定本身（三档模式的真值表），不是实现细节的复述：
 *   light  → 恒浅色
 *   dark   → 恒深色
 *   system → 由系统偏好决定
 */
describe('主题解析', () => {
  it('显式选择不受系统偏好影响', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('跟随系统时由系统偏好决定', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('模式轮换是浅色 → 深色 → 跟随系统 → 浅色', () => {
    expect(nextMode('light')).toBe('dark')
    expect(nextMode('dark')).toBe('system')
    expect(nextMode('system')).toBe('light')
  })

  it('非浏览器环境把系统偏好当浅色，不抛错', () => {
    expect(systemPrefersDark()).toBe(false)
  })
})

describe('主题落到 DOM', () => {
  it('写到 <html data-theme>，CSS 令牌靠它切换', () => {
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
