import { describe, expect, it } from 'vitest'
import { KB_TABS, tabOf, visibleTabs, type KbTabId } from './kbTabs'

/**
 * 知识库分栏的规格。
 *
 * 用户的原话：「我需要的一个单独的页面展示，而不是这种只有一个页面」。
 * 原来所有内容（登记文件夹 / 搜索 / 统计卡 / 已登记列表 / 历史）挤在一个长滚动页里，
 * 进来先看到的是一整屏「怎么用」的解释，搜索框要往下滚才够得着 —— 两类完全不同的
 * 使用场景（管理资料 vs 查资料）被塞进一个滚动流里，谁都难受。
 *
 * 规格：
 *  - 只有「资料管理」和「搜索浏览」两个 Tab，各自独立成页
 *  - 统计/索引进度属于「资料管理」（它关心的是资料库的状态）
 *  - 搜索历史属于「搜索浏览」（它服务于检索这个动作）
 *  - Tab 的 id 与标题是**数据**，不是散落在 JSX 里的字面量（可测、不会拼错）
 */
describe('知识库分栏', () => {
  it('只有两个 Tab：资料管理 / 搜索浏览', () => {
    expect(KB_TABS.map((t) => t.id)).toEqual(['manage', 'search'])
    expect(KB_TABS.map((t) => t.label)).toEqual(['资料管理', '搜索浏览'])
  })

  it('每个 Tab 都有可读的说明（顶栏副标题会显示）', () => {
    for (const t of KB_TABS) {
      expect(t.desc.length).toBeGreaterThan(4)
    }
  })

  it('索引进度、统计、已登记文件夹归到「资料管理」', () => {
    expect(tabOf('indexing').id).toBe('manage')
    expect(tabOf('stats').id).toBe('manage')
    expect(tabOf('folders').id).toBe('manage')
  })

  it('搜索框、结果、搜索历史归到「搜索浏览」', () => {
    expect(tabOf('searchBox').id).toBe('search')
    expect(tabOf('results').id).toBe('search')
    expect(tabOf('history').id).toBe('search')
  })

  it('默认停在「搜索浏览」：多数人来这个页面就是为了查东西', () => {
    // 登记资料是一次性动作，检索才是高频动作
    expect(KB_TABS[0].id).not.toBe('search')
    expect(visibleTabs()[1].id).toBe('search')
  })

  it('Tab 顺序稳定：资料管理在前，搜索浏览在后', () => {
    const ids: KbTabId[] = visibleTabs().map((t) => t.id)
    expect(ids).toEqual(['manage', 'search'])
  })
})
