import { beforeEach, describe, expect, it } from 'vitest'
import { useFlowStore } from './flowStore'
import type { Flow } from '@/lib/flowSearch'

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: 'f1',
  name: '退款处理方案',
  tags: ['售后'],
  steps: [{ id: 's1', title: '接收退款申请', desc: '粘贴订单号' }],
  ...over,
})

beforeEach(() => {
  useFlowStore.setState({ flows: [flow()] })
})

describe('方案 CRUD', () => {
  it('add 新增方案并分配 id', () => {
    useFlowStore.getState().add({ name: '发货跟进', tags: [], steps: [] })
    const list = useFlowStore.getState().flows
    expect(list).toHaveLength(2)
    expect(list[1].name).toBe('发货跟进')
    expect(list[1].id).toBeTruthy()
  })

  it('add 拒绝空名字——否则卡片上是一行空白', () => {
    useFlowStore.getState().add({ name: '  ', tags: [], steps: [] })
    expect(useFlowStore.getState().flows).toHaveLength(1)
  })

  it('update 改字段，保留原 id', () => {
    useFlowStore.getState().update('f1', { name: '退款处理（新版）' })
    expect(useFlowStore.getState().flows[0]).toMatchObject({ id: 'f1', name: '退款处理（新版）' })
  })

  it('update 不存在的 id 是安全空操作', () => {
    useFlowStore.getState().update('nope', { name: 'x' })
    expect(useFlowStore.getState().flows[0].name).toBe('退款处理方案')
  })

  it('remove 删掉方案', () => {
    useFlowStore.getState().remove('f1')
    expect(useFlowStore.getState().flows).toHaveLength(0)
  })

  it('duplicate 复制方案：步骤给新 id、名字加「副本」后缀', () => {
    useFlowStore.getState().duplicate('f1')
    const list = useFlowStore.getState().flows
    expect(list).toHaveLength(2)
    expect(list[1].name).toBe('退款处理方案 副本')
    // 步骤 id 必须换新的：两个方案共用步骤 id 会让"跳到第 3 步"串方案
    expect(list[1].steps[0].id).not.toBe(list[0].steps[0].id)
    expect(list[1].steps[0].title).toBe('接收退款申请')
  })
})

describe('步骤操作（只影响指定方案）', () => {
  const two = () => {
    useFlowStore.setState({
      flows: [flow(), flow({ id: 'f2', name: '别的方案', steps: [{ id: 'x1', title: '别的步骤', desc: '' }] })],
    })
  }

  it('addStep 只往目标方案加步骤', () => {
    two()
    useFlowStore.getState().addStep('f1', { id: 's2', title: '核对物流', desc: '' })
    expect(useFlowStore.getState().flows[0].steps).toHaveLength(2)
    expect(useFlowStore.getState().flows[1].steps).toHaveLength(1)
  })

  it('updateStep 改步骤内容', () => {
    useFlowStore.getState().updateStep('f1', 's1', { desc: '换成新的说明' })
    expect(useFlowStore.getState().flows[0].steps[0].desc).toBe('换成新的说明')
  })

  it('removeStep 删掉步骤', () => {
    two()
    useFlowStore.getState().addStep('f1', { id: 's2', title: '核对物流', desc: '' })
    useFlowStore.getState().removeStep('f1', 's2')
    expect(useFlowStore.getState().flows[0].steps).toHaveLength(1)
  })

  it('moveStep 上移/下移会换顺序', () => {
    two()
    useFlowStore.getState().addStep('f1', { id: 's2', title: '第二步', desc: '' })
    useFlowStore.getState().addStep('f1', { id: 's3', title: '第三步', desc: '' })
    useFlowStore.getState().moveStep('f1', 's3', -1)
    expect(useFlowStore.getState().flows[0].steps.map((s) => s.id)).toEqual(['s1', 's3', 's2'])
  })

  it('moveStep 在边界处不动，不会把步骤甩出数组', () => {
    useFlowStore.getState().moveStep('f1', 's1', -1)
    expect(useFlowStore.getState().flows[0].steps.map((s) => s.id)).toEqual(['s1'])
  })

  it('方案/步骤不存在时都是安全空操作', () => {
    useFlowStore.getState().addStep('nope', { id: 'x', title: '', desc: '' })
    useFlowStore.getState().moveStep('nope', 's1', 1)
    useFlowStore.getState().removeStep('nope', 's1')
    useFlowStore.getState().updateStep('f1', 'nope', { desc: 'x' })
    expect(useFlowStore.getState().flows[0].steps).toHaveLength(1)
  })
})

describe('派生', () => {
  it('byId 取方案', () => {
    expect(useFlowStore.getState().byId('f1')?.name).toBe('退款处理方案')
    expect(useFlowStore.getState().byId('nope')).toBeUndefined()
  })
})
