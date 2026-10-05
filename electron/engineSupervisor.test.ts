import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createEngineSupervisor } from './engineSupervisor'

/**
 * 引擎 sidecar 的生命周期监管。
 *
 * 两个真实事故：
 *  ① `spawn` 的错误是**异步 emit** 的，不挂 'error' 监听会被 Node 抛成
 *     未捕获异常、整个主进程崩掉（打包态引擎文件缺失、开发态没装 python 都走这条）
 *  ② 进程中途退出后引用不置空，`if (engineProcess) return` 以为它还活着，
 *     于是**再也拉不起来**，界面只表现为"引擎没反应"
 */

/** 假子进程：只需要能 kill、能 emit */
class FakeChild extends EventEmitter {
  killed = false
  kill(): boolean {
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }
}

const setup = () => {
  const children: FakeChild[] = []
  const onError = vi.fn()
  const sup = createEngineSupervisor({
    spawn: () => {
      const c = new FakeChild()
      children.push(c)
      return c as never
    },
    onError,
  })
  return { sup, children, onError }
}

describe('createEngineSupervisor', () => {
  it('第一次调用会拉起引擎', () => {
    const { sup, children } = setup()
    expect(sup.ensureRunning()).toBe(true)
    expect(children).toHaveLength(1)
    expect(sup.isRunning()).toBe(true)
  })

  it('已经在跑时再调不会重复拉起', () => {
    const { sup, children } = setup()
    sup.ensureRunning()
    expect(sup.ensureRunning()).toBe(false)
    expect(children).toHaveLength(1)
  })

  it('子进程报错不会把调用方带崩，且视为已停止', () => {
    const { sup, children, onError } = setup()
    sup.ensureRunning()
    expect(() => children[0].emit('error', new Error('spawn ENOENT'))).not.toThrow()
    expect(sup.isRunning()).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('子进程退出后视为已停止', () => {
    const { sup, children } = setup()
    sup.ensureRunning()
    children[0].emit('exit', 1, null)
    expect(sup.isRunning()).toBe(false)
  })

  it('报错或退出之后还能重新拉起', () => {
    const { sup, children } = setup()
    sup.ensureRunning()
    children[0].emit('error', new Error('boom'))
    expect(sup.ensureRunning()).toBe(true)
    expect(children).toHaveLength(2)
  })

  it('stop 会杀掉子进程并置空', () => {
    const { sup, children } = setup()
    sup.ensureRunning()
    sup.stop()
    expect(children[0].killed).toBe(true)
    expect(sup.isRunning()).toBe(false)
  })

  it('还没启动就 stop 不会出错', () => {
    const { sup } = setup()
    expect(() => sup.stop()).not.toThrow()
    expect(sup.isRunning()).toBe(false)
  })
})
