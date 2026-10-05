/** 只需要「能判断是否已销毁」+「能监听 closed」这两件事 */
export interface ClosableWindow {
  isDestroyed(): boolean
  on(event: 'closed', listener: () => void): unknown
}

export interface WindowHolder<T> {
  /** 登记窗口，并保证它关闭后自动置空 */
  set(win: T): T
  /** 当前窗口；已关闭或已销毁一律返回 null（调用方不必各自判断） */
  get(): T | null
  clear(): void
}

/**
 * 单例窗口的持有者。
 *
 * Electron 里窗口被关掉后对象还在，但 `isDestroyed()` 为真，此时调
 * `focus()/show()/setTitle()` 会抛 "Object has been destroyed"。
 * 之前只有 `instanceWindows` 在 `'closed'` 里摘除自己，`consoleWindow` 漏了 ——
 * 通知泵每轮都对着已销毁的窗口调 `setTitle()`，角标/标题静默停更。
 *
 * 抽出来是为了让「关掉即置空」成为**结构上的保证**，
 * 而不是每个新窗口都要记得手写一遍（第三个窗口迟早会再漏）。
 */
export function createWindowHolder<T extends ClosableWindow>(): WindowHolder<T> {
  let current: T | null = null

  const drop = (win: T) => {
    // 只摘自己登记的那一个：旧窗口迟到的 'closed' 不能把新窗口带走
    if (current === win) current = null
  }

  return {
    set(win: T): T {
      current = win
      win.on('closed', () => drop(win))
      return win
    },
    get(): T | null {
      if (current && current.isDestroyed()) {
        current = null
        return null
      }
      return current
    },
    clear(): void {
      current = null
    },
  }
}
