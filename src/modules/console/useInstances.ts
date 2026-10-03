import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useInstanceStore } from '@/stores/instanceStore'
import { isLive } from '@/modules/console/instanceStatus'

/**
 * 实例列表的单一数据入口：侧导航徽标、总览、实例管理、工具页、**实例窗口**共用一份缓存。
 *
 * 统一在这里带 refetchInterval，避免不同页面各自设频率互相覆盖。
 * 拉回的列表同时写进 zustand store（实例窗口与本窗口的配置页都读它）。
 */
export function useInstances() {
  const setInstances = useInstanceStore((s) => s.setInstances)
  const instances = useInstanceStore((s) => s.instances)
  /**
   * 有实例活跃时收紧轮询。
   *
   * 运行页的状态徽标、进度、执行明细都靠这一次拉取带回来 —— 空闲时 4 秒一次够用，
   * 但点下「开始执行」之后还等 4 秒才变徽标，用户会以为按钮没反应。
   */
  const anyLive = useMemo(() => Object.values(instances).some((i) => isLive(i.status)), [instances])

  const query = useQuery({
    queryKey: ['instances'],
    queryFn: api.listInstances,
    refetchInterval: anyLive ? 1200 : 4000,
  })

  useEffect(() => {
    if (query.data) setInstances(query.data)
  }, [query.data, setInstances])

  return query
}

export type EngineStatus = 'checking' | 'ok' | 'down'

/** 引擎连通性：给导航底部与设置页用 */
export function engineStatusOf(q: { isPending: boolean; isError: boolean; isSuccess: boolean }): EngineStatus {
  if (q.isPending) return 'checking'
  if (q.isError) return 'down'
  return q.isSuccess ? 'ok' : 'checking'
}
