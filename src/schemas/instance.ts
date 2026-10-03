import { z } from 'zod'

import { HOTKEY_ACTION_LABEL, formatAccel, normalizeAccel } from '@/lib/hotkey'
import { normalizeCombo } from '@/lib/keys'
import { templateIssues } from '@/lib/template'

/** 指令类型与工具类型 */
export const toolTypeSchema = z.enum(['rpa', 'monitor', 'logi', 'cmp', 'macro'])
export type ToolType = z.infer<typeof toolTypeSchema>

export const cmdTypeSchema = z.enum(['win', 'key', 'text', 'mouse', 'img', 'flow'])

/** 一条指令：参数是自由结构，由各类型自己的 schema 校验 */
export const cmdSchema = z.object({
  t: z.string().min(1),
  type: cmdTypeSchema,
  on: z.boolean().default(true),
  p: z.string().default(''),
  image: z
    .object({
      assetId: z.string().optional(),
      threshold: z.number().min(0.5).max(1).default(0.85),
      timeoutSec: z.number().int().positive().default(5),
      offsetX: z.number().default(0),
      offsetY: z.number().default(0),
      onMiss: z.enum(['fail', 'retry', 'pause']).default('fail'),
    })
    .optional(),
  key: z
    .object({
      combo: z.array(z.string()).min(1),
      delayMs: z.number().int().min(0).default(120),
      repeat: z.number().int().min(1).default(1),
    })
    // 键名走**白名单**：认不出来就在保存时拦住。放过去的话运行期
    // `pyautogui.hotkey('Ctr','C')` 的表现是「什么都没发生」，最难查的一类故障。
    // 这里只校验不重写 —— 归一化（`Ctrl` → `ctrl`）交给引擎，存档保持用户写法。
    .superRefine((k, ctx) => {
      const { reason } = normalizeCombo(k.combo)
      if (reason) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `按键不合法：${reason}`, path: ['combo'] })
    })
    .optional(),
})
/** 指令类型决定必填参数：缺了这些参数，执行到一半才会失败，不如在保存时就拦住 */
.superRefine((c, ctx) => {
  if (c.type === 'key' && !c.key?.combo?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '按键指令需要指定按键', path: ['key', 'combo'] })
  }
  if (c.type === 'img' && !c.image) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '图像指令需要先选择一张素材', path: ['image'] })
  }
  // 光有 image 对象不够：assetId 为空说明还没配图，执行时只会报「图像库里没有这个素材」。
  // 强删素材会把 assetId 清空，于是那条指令也回到「需要重新选图」状态。
  if (c.type === 'img' && c.image && !c.image.assetId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '这条图像指令还没选素材，请从图像库中选一张', path: ['image', 'assetId'] })
  }
})
export type Cmd = z.infer<typeof cmdSchema>

/**
 * 哪些指令的 `p` 会被当模板渲染 —— 决定保存时要校验谁。
 *
 * 按键的 `p` 是说明文字、图像的 `p` 是备注，把它们也当模板校验会凭空报错。
 */
const TEMPLATE_CMD_TYPES: readonly Cmd['type'][] = ['text', 'win', 'flow']

/**
 * 全局快捷键：随实例走，不是全局一份。
 *
 * 两个实例做同一件事时确实会想用同一个键，所以这里允许重复，
 * 由主进程按「焦点窗口 > 最近用过 > 最早创建的」确定性地挑一个执行 ——
 * 它解决的是「F9 会不会把两个实例一起暂停」。答案是不会，但冲突要能看见。
 */
export const DEFAULT_HOTKEYS = { run: 'F8', toggle: 'F9', stop: 'F10', scope: 'window' } as const

export const hotkeyMapSchema = z
  .object({
    /** 开始执行 */
    run: z.string().min(1).default(DEFAULT_HOTKEYS.run),
    /** 暂停 / 继续 */
    toggle: z.string().min(1).default(DEFAULT_HOTKEYS.toggle),
    /** 停止 */
    stop: z.string().min(1).default(DEFAULT_HOTKEYS.stop),
    /** 按下后作用于谁：只要这一个实例，还是同工具的全部实例 */
    scope: z.enum(['window', 'tool']).default(DEFAULT_HOTKEYS.scope),
  })
  /**
   * **同一个实例**的两个动作不能共用同一个键。
   *
   * 跨实例共用是有意允许的（主进程按「焦点 > 最近用过 > 在跑 > 键名排序」确定性地挑一个），
   * 但实例内部共用就成了「按下去谁响应看数组顺序」—— 那是随机行为，按下 F8 有时开始、
   * 有时暂停，用户根本找不到规律。
   *
   * 认不出来的键（`normalizeAccel` 返回 null）不参与判重，交给拾取器单独报「不知道这个键」，
   * 免得一条烂配置同时报两条错。
   */
  .superRefine((m, ctx) => {
    const byAccel = new Map<string, string[]>()
    for (const action of ['run', 'toggle', 'stop'] as const) {
      const accel = normalizeAccel(m[action])
      if (!accel) continue
      byAccel.set(accel, [...(byAccel.get(accel) ?? []), HOTKEY_ACTION_LABEL[action]])
    }
    for (const [accel, actions] of byAccel) {
      if (actions.length < 2) continue
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${formatAccel(accel)} 被「${actions.join('」「')}」重复占用，同一实例里每个动作要用不同的键`,
        path: ['run'],
      })
    }
  })
export type HotkeyMapConfig = z.infer<typeof hotkeyMapSchema>

/** 自动化实例配置：列语义按产品约定固定 */
export const rpaConfigSchema = z.object({
  excelPath: z.string().min(1),
  /** 客户名称列 = 搜索关键词 */
  colName: z.string().min(1),
  /** 消息内容列 = 每行发送内容（统一内容开启时被忽略） */
  colMsg: z.string().optional(),
  /** 状态列：留空则由程序自动创建「执行状态」列 */
  colStatus: z.string().optional(),
  unified: z.boolean().default(false),
  unifiedText: z.string().default(''),
  from: z.number().int().min(1).default(1),
  to: z.number().int().min(1).default(1),
  retry: z.number().int().min(0).default(2),
  onFail: z.enum(['continue', 'pause']).default('continue'),
  skipSuccess: z.boolean().default(true),
  writeReason: z.boolean().default(true),
  backup: z.boolean().default(true),
  cmds: z.array(cmdSchema).default([]),
  /** 上传 Excel 后探测到的表头；列映射下拉的可选项（引擎不读它，纯前端体验） */
  columns: z.array(z.string()).default([]),
  /**
   * 上传时抓下来的那一行真值，配置页拿它做实时预览（引擎不读它）。
   * 存进配置是为了刷新之后预览还在 —— 否则每次进页面都得重新上传一遍 Excel。
   */
  sample: z
    .object({
      row_no: z.number().default(2),
      key: z.string().default(''),
      values: z.record(z.string(), z.unknown()).default({}),
    })
    .optional(),
})
.refine((c) => c.to >= c.from, { message: '结束行不能小于起始行', path: ['to'] })
/**
 * 保存时就校验模板引用的列 —— 以前只有跑起来才发现「当前行没有这一列」。
 *
 * 判定逻辑直接复用 `templateIssues`（和预览、和引擎都是同一套语义），
 * 所以这里不会出现「保存说没问题、跑起来才炸」。
 */
.superRefine((c, ctx) => {
  // 还没上传 Excel 就不知道有哪些列，这时候校验只会报一堆假警
  if (c.columns.length === 0) return

  c.cmds.forEach((cmd, index) => {
    if (!TEMPLATE_CMD_TYPES.includes(cmd.type)) return
    for (const message of templateIssues(cmd.p, c.columns)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['cmds', index, 'p'] })
    }
  })
})
export type RpaConfig = z.infer<typeof rpaConfigSchema>

/**
 * 按键精灵：**没有数据源**的指令序列。
 *
 * 与 `rpa` 的关键差别是「没有表」—— 不读 Excel、不逐行、不回写状态列，
 * 所以这里没有 `excelPath` / 列映射 / `from`~`to` / `skipSuccess` 那一套。
 * 指令本身完全复用 `cmdSchema`，组合键、模板、失败原因的行为两边一致。
 *
 * 刻意**不设 `trigger`（触发方式）这种枚举**：触发就是这个实例的全局快捷键
 * （`hotkeys.run`，默认 F8），它在配置最外层、已经真接上了主进程注册表。
 * 再加一个「手动 / 快捷键」开关等于同一件事两块开关，关掉哪个都不对。
 */
export const macroConfigSchema = z.object({
  cmds: z.array(cmdSchema).default([]),
})
export type MacroConfig = z.infer<typeof macroConfigSchema>

/** 物流查询方式：不依赖接口的前两种为可用路径 */
export const providerSchema = z.enum(['excel', 'web', 'api'])

export const siteAdapterSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  input: z.string(),
  button: z.string(),
  result: z.string(),
  status: z.string(),
  trace: z.string(),
})

export const logiConfigSchema = z.object({
  file: z.string().min(1),
  colWaybill: z.string().min(1),
  provider: providerSchema.default('excel'),
  /** ① Excel 匹配合并所需对照表 */
  refFile: z.string().optional(),
  refNo: z.string().optional(),
  refStatus: z.string().optional(),
  /** ② 网页自动化所需站点适配器 */
  site: siteAdapterSchema.optional(),
  intervalMs: z.number().int().min(800).default(1500),
  retry: z.number().int().min(0).default(2),
  pauseOnCaptcha: z.boolean().default(true),
  /** 上传 Excel 后探测到的表头，供「物流单号列」下拉选择 */
  columns: z.array(z.string()).default([]),
})
export type LogiConfig = z.infer<typeof logiConfigSchema>

/** Excel 对比：A 表参与对比的字段，role 决定它是「匹配行用的主键」还是「要比对的值」 */
export const compareFieldSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['key', 'compare']).default('compare'),
  type: z.enum(['text', 'number']).default('text'),
})
export type CompareField = z.infer<typeof compareFieldSchema>

export const cmpTableSchema = z.object({
  path: z.string(),
  columns: z.array(z.string()),
})

export const cmpConfigSchema = z
  .object({
    /** A 表（主表 / 基准表） */
    primaryFile: z.string().default(''),
    primaryColumns: z.array(z.string()).default([]),
    primaryFields: z.array(compareFieldSchema).default([]),
    /** 对比表 B/C…：路径列表 + 按文件名存的表信息 */
    otherFiles: z.array(z.string()).default([]),
    tables: z.record(cmpTableSchema).default({}),
    /** 映射：{ 对比表文件名: { A字段名: 该表列名 | null } } */
    maps: z.record(z.record(z.string().nullable())).default({}),
    tolerance: z.number().min(0).default(0),
    outFile: z.string().default(''),
  })
  .refine((c) => c.primaryFields.length === 0 || c.primaryFields.some((f) => f.role === 'key'), {
    message: '至少要指定一个主键字段（用于匹配行，如订单号）',
    path: ['primaryFields'],
  })
export type CmpConfig = z.infer<typeof cmpConfigSchema>

/**
 * 实例配置：`hotkeys` 是**实例级**属性，统一放在最外层，不藏进各工具的子对象里。
 *
 * 它描述的是「这个实例怎么被键盘控制」，跟工具本身做什么无关；
 * 放在各分支里会让读取方（主进程注册表、设置页）必须知道四种嵌套路径，很容易读漏。
 */
export const instanceConfigSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('rpa'),
    window: z.string().min(1),
    rpa: rpaConfigSchema,
    hotkeys: hotkeyMapSchema.default(DEFAULT_HOTKEYS),
  }),
  z.object({
    tool: z.literal('macro'),
    /** 必填，且引擎侧也认这条底线（没窗口直接拒绝执行，不往「当前前台窗口」乱按） */
    window: z.string().min(1),
    macro: macroConfigSchema,
    hotkeys: hotkeyMapSchema.default(DEFAULT_HOTKEYS),
  }),
  z.object({
    tool: z.literal('monitor'),
    region: z.string(),
    rules: z.array(z.object({ assetId: z.string(), threshold: z.number() })),
    hotkeys: hotkeyMapSchema.default(DEFAULT_HOTKEYS),
  }),
  z.object({ tool: z.literal('logi'), logi: logiConfigSchema, hotkeys: hotkeyMapSchema.default(DEFAULT_HOTKEYS) }),
  z.object({ tool: z.literal('cmp'), cmp: cmpConfigSchema, hotkeys: hotkeyMapSchema.default(DEFAULT_HOTKEYS) }),
])
export type InstanceConfig = z.infer<typeof instanceConfigSchema>

/** 行状态：执行结果回写与跳过成功行都以此为准 */
export const rowStatusSchema = z.enum(['ok', 'err', 'skip', 'wait'])
export type RowStatus = z.infer<typeof rowStatusSchema>

export const rowSchema = z.object({
  rowNo: z.number().int().positive(),
  keyValue: z.string(),
  status: rowStatusSchema,
  message: z.string().default(''),
  durationMs: z.number().int().nonnegative().default(0),
})
export type Row = z.infer<typeof rowSchema>

/** 实例状态机：只允许下列迁移 */
export const instanceStatusSchema = z.enum([
  'idle',
  'starting',
  'running',
  'paused',
  'stopping',
  'completed',
  'error',
  'armed',
])
export type InstanceStatus = z.infer<typeof instanceStatusSchema>

export const ALLOWED_TRANSITIONS: Record<InstanceStatus, InstanceStatus[]> = {
  idle: ['starting', 'armed', 'error'],
  starting: ['running', 'error', 'idle'],
  running: ['paused', 'stopping', 'completed', 'error'],
  paused: ['running', 'stopping', 'error'],
  stopping: ['idle', 'error'],
  completed: ['idle'],
  error: ['idle', 'starting'],
  armed: ['idle', 'error'],
}

export const instanceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tool: toolTypeSchema,
  status: instanceStatusSchema.default('idle'),
  done: z.number().int().nonnegative().default(0),
  total: z.number().int().nonnegative().default(0),
  config: instanceConfigSchema,
  updatedAt: z.number().default(() => Date.now()),
})
export type Instance = z.infer<typeof instanceSchema>
