import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { createWindowHolder } from './windowRegistry'

/**
 * 单例窗口的持有者。
 *
 * Electron 里窗口被关掉后，对象还在但 `isDestroyed()` 为真，此时调
 * `focus()/show()/setTitle()` 会抛 "Object has been destroyed"。
 * 之前只有 `instanceWindows` 在 'closed' 里摘除自己，`consoleWindow` 漏了 ——
 * 通知泵每轮都对着已销毁的窗口调 `setTitle()`，角标/标题静默停更。
 *
 * 抽出来是为了让「关掉即置空」成为**结构上的保证**，而不是每个窗口都要记得写。
 */

/** 假窗口：只需要 isDestroyed + on('closed') */
class FakeWindow extends EventEmitter {
  destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
  /** 模拟用户关掉窗口 */
  close_(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

describe('createWindowHolder', () => {
  it('set 之后 get 拿得到它', () => {
    const holder = createWindowHolder<FakeWindow>()
    const win = new FakeWindow()
    holder.set(win)
    expect(holder.get()).toBe(win)
  })

  it('窗口被销毁后 get 返回 null —— 调用方不必各自判断 isDestroyed', () => {
    const holder = createWindowHolder<FakeWindow>()
    holder.set(new FakeWindow())
    // 只置 destroyed、不发 'closed'（真实 Electron 里也可能这样）
    ;(holder.get() as FakeWindow).destroyed = true
    expect(holder.get()).toBeNull()
  })

  it('窗口 closed 后 get 返回 null', () => {
    const holder = createWindowHolder<FakeWindow>()
    const win = new FakeWindow()
    holder.set(win)
    win.close_()
    expect(holder.get()).toBeNull()
  })

  it('换上新窗口后，旧窗口 closed 不会把新窗口摘掉', () => {
    const holder = createWindowHolder<FakeWindow>()
    const oldWin = new FakeWindow()
    holder.set(oldWin)
    const newWin = new FakeWindow()
    holder.set(newWin)

    oldWin.close_()

    expect(holder.get()).toBe(newWin)
  })

  it('clear 之后为空', () => {
    const holder = createWindowHolder<FakeWindow>()
    holder.set(new FakeWindow())
    holder.clear()
    expect(holder.get()).toBeNull()
  })
})
