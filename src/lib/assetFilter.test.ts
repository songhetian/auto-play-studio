import { describe, expect, it } from 'vitest'
import { filterAssets, groupProblems, tagsOf } from '@/lib/assetFilter'
import type { AssetProblem, ImageAsset } from '@/lib/api'

const asset = (id: string, name: string, tag: string, refCount = 0): ImageAsset => ({
  id,
  name,
  path: `C:/assets/${id}.png`,
  width: 10,
  height: 10,
  threshold: 0.85,
  tag,
  createdAt: '2026-01-01 00:00:00',
  refCount,
})

const LIB = [
  asset('img_1', '发送按钮', '按钮类', 2),
  asset('img_2', '标题栏', '标题类'),
  asset('img_3', '确定按钮', '按钮类'),
  asset('img_4', 'DingTalk 图标', '图标类'),
]

describe('素材筛选', () => {
  it('不传条件就全给', () => {
    expect(filterAssets(LIB, {}).map((a) => a.id)).toEqual(['img_1', 'img_2', 'img_3', 'img_4'])
  })

  it('按名字模糊匹配，忽略大小写', () => {
    expect(filterAssets(LIB, { keyword: 'dingtalk' }).map((a) => a.id)).toEqual(['img_4'])
    expect(filterAssets(LIB, { keyword: '按钮' }).map((a) => a.id)).toEqual(['img_1', 'img_3'])
  })

  it('关键词两边的空格不算数', () => {
    expect(filterAssets(LIB, { keyword: '  标题  ' }).map((a) => a.id)).toEqual(['img_2'])
  })

  it('按标签筛', () => {
    expect(filterAssets(LIB, { tag: '按钮类' }).map((a) => a.id)).toEqual(['img_1', 'img_3'])
  })

  it('标签「全部」等于不筛', () => {
    expect(filterAssets(LIB, { tag: '全部' })).toHaveLength(4)
  })

  it('关键词与标签同时生效', () => {
    expect(filterAssets(LIB, { keyword: '按钮', tag: '按钮类' }).map((a) => a.id)).toEqual(['img_1', 'img_3'])
    expect(filterAssets(LIB, { keyword: '标题', tag: '按钮类' })).toEqual([])
  })

  it('标签列表去重且排序稳定', () => {
    expect(tagsOf(LIB)).toEqual(['按钮类', '标题类', '图标类'])
  })

  it('空库不给标签', () => {
    expect(tagsOf([])).toEqual([])
  })
})

describe('体检问题按素材归类', () => {
  const problem = (assetId: string, kind: AssetProblem['kind'], cmdIndex = 0): AssetProblem => ({
    assetId,
    kind,
    detail: 'x',
    instanceId: 'R1',
    instanceName: '客服账号A',
    cmdIndex,
    cmdName: '图像',
  })

  it('同一个素材的多处问题归到一起', () => {
    const grouped = groupProblems([problem('img_1', 'missing_file'), problem('img_1', 'missing_file', 1)])

    expect(Object.keys(grouped)).toEqual(['img_1'])
    expect(grouped.img_1).toHaveLength(2)
  })

  it('没问题的素材不出现在结果里', () => {
    expect(groupProblems([])).toEqual({})
    expect(groupProblems([problem('img_9', 'missing_asset')])).not.toHaveProperty('img_2')
  })
})
