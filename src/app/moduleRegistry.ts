import type { ToolType } from '@/schemas/instance'
import type { IconName } from '@/components/icon'

/**
 * 工具的功能类型分组。
 *
 * 分类标准是「**谁触发、产出什么**」，不是「产物是什么格式」：
 * 后者的结果是把常驻盯屏的提醒器（monitor）和批处理执行器（rpa）塞进同一组。
 */
export type ToolGroupId = 'exec' | 'data' | 'alert' | 'assist'

export interface ToolModule {
  id: ToolType
  name: string
  /** 一句话说明，工具卡片、导航悬停、工具落地页共用 */
  desc: string
  color: string
  /** 工具箱格子与导航用的语义图标名 */
  icon: IconName
  multiOpen: boolean
  status: 'ready' | 'planned'
  /**
   * 归属的功能类型分组。
   *
   * 工具的元数据**只有这一份** —— 导航条目的名字/说明/图标/颜色/别名都从这里取。
   * 曾经 navModel 里另存了一份，结果同一个工具在侧栏和工具卡上显示两句不同的话。
   */
  group: ToolGroupId
  /** 搜索别名：英文 id、同义词、用户可能输入的叫法 */
  keywords: string[]
  /** 落地页的「使用要点」：告诉用户用之前要准备什么，减少配到一半才发现缺东西 */
  hints: string[]
}

/** 工具箱注册表：新增工具只需在此加一行，并在路由中挂上对应页面 */
export const TOOLS: ToolModule[] = [
  {
    id: 'rpa',
    name: '自动化脚本助手',
    desc: '绑定一个目标窗口，按 Excel 数据逐行执行脚本指令',
    color: '#165DFF',
    icon: 'rpa',
    multiOpen: true,
    status: 'ready',
    // 程序调度 + 驱动键鼠 + 按 Excel 回写状态
    group: 'exec',
    keywords: ['rpa', '脚本', '自动化', '点击', '输入', '键盘', '鼠标', '窗口', '流程编排', '指令'],
    hints: [
      '先上传 Excel，系统会自动识别列名与行数',
      '把「客户名称列」映射到搜索关键词列，运行时会以它为每行输入',
      '流程编排里至少要有一条指令，否则每行都会因无事可做而空跑',
      '运行前请确保目标窗口已打开且没有被其它窗口遮挡',
    ],
  },
  {
    id: 'macro',
    name: '按键精灵',
    desc: '不用准备表格，绑定一个窗口按顺序按几下键',
    color: '#F53F3F',
    icon: 'macro',
    multiOpen: true,
    status: 'ready',
    // 人按快捷键触发 + 产出当前窗口里的结果 —— 不是批处理，不归执行类
    group: 'assist',
    keywords: ['macro', '按键精灵', '快捷操作', '组合键', '宏', '键盘', '连按', '一键', '复制粘贴'],
    hints: [
      '这是「一次性动作」工具：没有数据源、不分行，点一下就把整串动作走一遍',
      '先绑定目标窗口 —— 没有窗口就不知道该往哪儿按键，引擎会直接拒绝执行',
      '按键支持组合键（Ctrl+C、Ctrl+Shift+V），写错键名会在保存时当场报错',
      '想一键触发就给「开始执行」配一个全局键（默认 F8），按一下就跑，不用切回来点按钮',
    ],
  },
  {
    id: 'monitor',
    name: '桌面图片监控',
    desc: '监测屏幕指定区域，图片出现即记录告警',
    color: '#00B42A',
    icon: 'monitor',
    multiOpen: true,
    status: 'ready',
    // 外部事件（画面里出现了目标）触发 + 产出通知 —— 常驻盯屏的提醒器，不是执行器
    group: 'alert',
    keywords: ['monitor', '监控', '图像', '识别', '模板匹配', '告警', '报警', 'opencv', '盯屏'],
    hints: [
      '监控目标取自「图像素材库」，先去素材库导入或框选一张目标图',
      '区域填 full 监测整屏，或框选一块矩形只在那里查找，减少误报',
      '相似度阈值越高越严格：背景多变的场景建议 0.8 以上',
      '画面中目标持续存在只记一次命中，不会刷屏',
    ],
  },
  {
    id: 'guard',
    name: '敏感词监控',
    desc: '盯住聊天输入框，客服打出违禁词立即弹窗提醒',
    color: '#5B5BD6',
    icon: 'shield',
    multiOpen: true,
    status: 'ready',
    // 外部事件（客服打了不该说的词）触发 + 产出通知 —— 与图片监控同一位置
    group: 'alert',
    keywords: ['guard', '敏感词', '违禁词', '违限词', '屏蔽词', '合规', '风控', '质检', '审核', '聊天监控'],
    hints: [
      '词库是全局共用的：先在「敏感词库」里配好词，再回来建实例',
      '先绑定目标窗口（京麦 / 千牛 / 企微），没绑定就不知道该读哪个输入框',
      '危级分高 / 中 / 低三档，建议先只开「高危」，用顺手了再放开中低危',
      '同一句话在两分钟内只报一次：客服正在打字时会连续多轮读到同一段文字',
    ],
  },
  {
    id: 'logi',
    name: '物流信息查询',
    desc: '传入 Excel → 自动检测列 → 选物流单号列 → 查询并写入新文件',
    color: '#0891B2',
    icon: 'logi',
    multiOpen: true,
    status: 'ready',
    // 程序调度 + 不碰屏幕 + 出 Excel
    group: 'data',
    keywords: ['logi', 'logistics', '物流', '快递', '单号', '查件', '运单', '轨迹'],
    hints: [
      '上传含运单号的 Excel，并指定哪一列是物流单号',
      '① Excel 匹配合并最稳：用平台导出的物流表按单号合并，纯本地完成',
      '② 网页自动化无需接口，但要按目标网站填写站点适配器的选择器',
      '原文件保持只读，结果写入新文件；查过的单号会进本地缓存',
    ],
  },
  {
    id: 'cmp',
    name: 'Excel 多表对比',
    desc: '以 A 表为基准，自动匹配列名，找出与 B/C 表的差异并生成报告',
    color: '#722ED1',
    icon: 'cmp',
    multiOpen: true,
    status: 'ready',
    // 程序调度 + 不碰屏幕 + 出报告
    group: 'data',
    keywords: ['cmp', 'compare', 'excel', '对比', '差异', '表格', '比对', '对账', '多表'],
    hints: [
      '先上传 A 表作为基准表，再上传要对比的 B/C 表',
      '至少要指定一个「主键字段」用于匹配行，否则无法对齐',
      '列名不一致时系统会自动匹配，也可以手动改映射',
      '数值字段可以设置容差，避免浮点误差被算成差异',
    ],
  },
]

export const toolById = (id: ToolType) => TOOLS.find((t) => t.id === id)!

/** 路径参数是否是一个真实存在的工具 id */
export const isToolId = (id: string): id is ToolType => TOOLS.some((t) => t.id === id)
