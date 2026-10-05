/** 子进程句柄：只需要「能被 kill」+「能 emit」 */
export interface EngineChild {
  kill(): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
}

export interface EngineSupervisorDeps {
  /** 真正去起进程。注入是为了能测 —— 真机上就是 spawn(...) */
  spawn: () => EngineChild
  /** 引擎起不来时的出口（写日志 / 弹提示） */
  onError?: (err: Error) => void
}

export interface EngineSupervisor {
  /** 幂等启动；返回是否**这次真的拉起来了** */
  ensureRunning(): boolean
  isRunning(): boolean
  stop(): void
}

/**
 * 引擎 sidecar 的生命周期监管。
 *
 * 修掉两个真实事故：
 *  ① `spawn` 的错误是**异步 emit** 的，不挂 `'error'` 监听会被 Node 抛成
 *     未捕获异常、整个主进程崩掉（打包态引擎文件缺失、开发态机器没装 python
 *     都会走到这里）
 *  ② 进程中途退出后引用不置空，`if (child) return` 以为它还活着 ——
 *     于是**再也拉不起来**，界面只表现为「引擎没反应」
 */
export function createEngineSupervisor(deps: EngineSupervisorDeps): EngineSupervisor {
  let child: EngineChild | null = null

  const drop = () => {
    child = null
  }

  return {
    ensureRunning(): boolean {
      if (child) return false
      const c = deps.spawn()
      // 先登记再挂监听：'exit' 可能在监听挂上之前就到来
      child = c
      c.on('error', (err) => {
        // 只是记录，不重抛 —— 重抛就是主进程崩溃
        deps.onError?.(err)
        drop()
      })
      c.on('exit', () => drop())
      return true
    },
    isRunning(): boolean {
      return child !== null
    },
    stop(): void {
      const c = child
      drop()
      try {
        c?.kill()
      } catch {
        // 已经退出时 kill 可能抛；停不下来不该影响退出流程
      }
    },
  }
}
