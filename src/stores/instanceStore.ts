import { z } from 'zod'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  Instance,
  InstanceConfig,
  InstanceStatus,
  ToolType,
  Cmd,
  RpaConfig,
  MacroConfig,
  LogiConfig,
  CmpConfig,
  HotkeyMapConfig,
} from '@/schemas/instance'
import {
  ALLOWED_TRANSITIONS,
  cmpConfigSchema,
  guardConfigSchema,
  hotkeyMapSchema,
  logiConfigSchema,
  macroConfigSchema,
  rpaConfigSchema,
} from '@/schemas/instance'
import type { AlertSound } from '@/lib/alertSound'
import { alertSoundSchema } from '@/lib/alertSound'

interface InstanceState {
  instances: Record<string, Instance>
  activeId: string | null
  setInstances: (list: Instance[]) => void
  upsert: (inst: Instance) => void
  /** 改实例名（只动 name，不碰配置与状态） */
  rename: (id: string, name: string) => void
  remove: (id: string) => void
  setActive: (id: string | null) => void
  /** 状态机守卫：非法迁移直接拒绝 */
  transition: (id: string, next: InstanceStatus) => boolean
  patchConfig: (id: string, patch: ConfigPatch & InstanceLevelPatch) => void
  setCmds: (id: string, cmds: Cmd[]) => void
  /** 改单条指令的参数：p 是浅合并，key / image 是深一层合并（属性面板逐项编辑用） */
  patchCmd: (id: string, index: number, patch: Partial<Cmd>) => void
}

/** 合并指令的嵌套参数：只改了阈值，不该把 assetId 一起丢掉 */
function mergeNested<T extends object>(prev: T | undefined, patch: T | undefined): T | undefined {
  if (!patch) return prev
  return { ...(prev ?? ({} as T)), ...patch }
}

/** 局部更新：工具那一层（rpa / macro / logi / cmp）做一层合并，避免只改一列就把流程指令抹掉 */
type ConfigPatch =
  | { tool?: 'rpa'; window?: string; rpa?: Partial<RpaConfig> }
  | { tool?: 'macro'; window?: string; macro?: Partial<MacroConfig> }
  | { tool?: 'logi'; logi?: Partial<LogiConfig> }
  | {
      tool?: 'monitor'
      region?: string
      rules?: Array<{ assetId: string; threshold: number }>
      /** 每个实例单独一套告警声音 */
      alertSound?: Partial<AlertSound>
    }
  | { tool?: 'cmp'; cmp?: Partial<CmpConfig> }

/**
 * 「有指令序列」的工具 → 它的 `cmds` 在哪。
 *
 * `rpa` 与 `macro` 只是数据源不同（一张表 / 没有表），指令本身是同一套 `Cmd`、
 * 同一套编排 UI，所以读写路径只在这一个函数里决定，别处不再各写一次 if。
 * 返回 `null` 表示这个工具没有指令序列 —— 调用方一律**静默忽略**，
 * 而不是把 `cmds` 挂到配置根上（那样会悄悄污染存档）。
 */
function cmdsOf(cfg: InstanceConfig): Cmd[] | null {
  if (cfg.tool === 'rpa') return cfg.rpa.cmds
  if (cfg.tool === 'macro') return cfg.macro.cmds
  return null
}

/** 换掉指令序列，其余字段原样保留 */
function withCmds(cfg: InstanceConfig, cmds: Cmd[]): InstanceConfig {
  if (cfg.tool === 'rpa') return { ...cfg, rpa: { ...cfg.rpa, cmds } }
  if (cfg.tool === 'macro') return { ...cfg, macro: { ...cfg.macro, cmds } }
  return cfg
}

/**
 * 与工具无关的实例级字段，可以和上面任意一支叠加。
 * 快捷键描述「这个实例怎么被键盘控制」，不属于任何工具，所以放这里。
 */
type InstanceLevelPatch = { hotkeys?: Partial<HotkeyMapConfig> }

/**
 * 剥掉 `.refine()` / `.superRefine()` / `.default()` 的壳，取到最里层那个 ZodObject。
 *
 * patch 只该管「字段名对不对、类型对不对」；跨字段规则（行区间 `to >= from`、
 * 快捷键是否重复、cmp 有没有主键）不在这里判 —— 见下面的 `PATCH_SCHEMAS`。
 */
function plainObject(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> {
  let s: z.ZodTypeAny = schema
  for (;;) {
    if (s instanceof z.ZodEffects) s = s.innerType()
    else if (s instanceof z.ZodDefault) s = s.removeDefault()
    else if (s instanceof z.ZodOptional) s = s.unwrap()
    else break
  }
  return s as z.ZodObject<z.ZodRawShape>
}

const patchOf = (schema: z.ZodTypeAny) => plainObject(schema).partial()

const hotkeysPatchSchema = patchOf(hotkeyMapSchema)
const alertSoundPatchSchema = patchOf(alertSoundSchema)

/**
 * 写入收口：patch 必须是**当前工具那支配置的 partial 形态**。
 *
 * 为什么不干脆拿整份 `instanceConfigSchema` 校验合并结果：配置页是**刻意允许中间态**存在的 ——
 * 行区间还没填对、快捷键暂时重复、cmp 还没来得及选主键，这些错误由 `zodFieldErrors`
 * 逐字段展示、并据此禁用保存。若在这里按整份 schema 拒写，那些控件会直接改不动，
 * 校验点就跑到了错误的地方。
 *
 * 所以这里只拦「结构上根本不可能」的 patch：类型不对、字段名写错、混进了别的工具的字段。
 * 顶层用 `.strict()` —— 跨工具写错字段（给 logi 实例传 `rpa`）是最难查的一类 bug。
 */
const PATCH_SCHEMAS: Record<ToolType, z.ZodTypeAny> = {
  rpa: z
    .object({
      tool: z.literal('rpa').optional(),
      window: z.string().optional(),
      rpa: patchOf(rpaConfigSchema).optional(),
      hotkeys: hotkeysPatchSchema.optional(),
    })
    .strict(),
  macro: z
    .object({
      tool: z.literal('macro').optional(),
      window: z.string().optional(),
      macro: patchOf(macroConfigSchema).optional(),
      hotkeys: hotkeysPatchSchema.optional(),
    })
    .strict(),
  logi: z
    .object({
      tool: z.literal('logi').optional(),
      logi: patchOf(logiConfigSchema).optional(),
      hotkeys: hotkeysPatchSchema.optional(),
    })
    .strict(),
  cmp: z
    .object({
      tool: z.literal('cmp').optional(),
      cmp: patchOf(cmpConfigSchema).optional(),
      hotkeys: hotkeysPatchSchema.optional(),
    })
    .strict(),
  monitor: z
    .object({
      tool: z.literal('monitor').optional(),
      region: z.string().optional(),
      rules: z.array(z.object({ assetId: z.string(), threshold: z.number() })).optional(),
      alertSound: alertSoundPatchSchema.optional(),
      hotkeys: hotkeysPatchSchema.optional(),
    })
    .strict(),
  guard: z
    .object({
      tool: z.literal('guard').optional(),
      window: z.string().optional(),
      guard: patchOf(guardConfigSchema).optional(),
      alertSound: alertSoundPatchSchema.optional(),
      hotkeys: hotkeysPatchSchema.optional(),
    })
    .strict(),
}

export const useInstanceStore = create<InstanceState>()(
  persist(
    (set, get) => ({
      instances: {},
      activeId: null,

      setInstances: (list) =>
        set(() => ({
          instances: Object.fromEntries(list.map((i) => [i.id, i])),
          activeId: get().activeId ?? list[0]?.id ?? null,
        })),

      upsert: (inst) => set((s) => ({ instances: { ...s.instances, [inst.id]: inst } })),

      /** 改名：只动 name，其余配置原样保留（改名不该碰运行状态） */
      rename: (id, name) =>
        set((s) => {
          const cur = s.instances[id]
          if (!cur) return s
          return { instances: { ...s.instances, [id]: { ...cur, name } } }
        }),

      remove: (id) =>
        set((s) => {
          const next = { ...s.instances }
          delete next[id]
          return { instances: next, activeId: s.activeId === id ? null : s.activeId }
        }),

      setActive: (id) => set({ activeId: id }),

      transition: (id, next) => {
        const cur = get().instances[id]
        if (!cur) return false
        if (!ALLOWED_TRANSITIONS[cur.status].includes(next)) return false
        set((s) => ({
          instances: { ...s.instances, [id]: { ...cur, status: next, updatedAt: Date.now() } },
        }))
        return true
      },

      patchConfig: (id, patch) => {
        const cur = get().instances[id]
        if (!cur) return
        // 写入点收口：坏 patch 一旦进 store，会被 persist 直接写进 localStorage，
        // 要等到读取或执行时才炸。这里拒写，并在开发期喊出来（生产期静默丢弃，界面不该因此崩）。
        const check = PATCH_SCHEMAS[cur.config.tool].safeParse(patch)
        if (!check.success) {
          if (import.meta.env.DEV) {
            console.warn(`[instanceStore] 拒绝非法 patch（${cur.config.tool}）`, check.error.issues)
          }
          return
        }
        const merged: Record<string, unknown> = { ...cur.config }
        for (const [key, value] of Object.entries(patch)) {
          const prev = (cur.config as unknown as Record<string, unknown>)[key]
          const nested = value !== null && typeof value === 'object' && !Array.isArray(value)
          merged[key] = nested && prev && typeof prev === 'object'
            ? { ...(prev as object), ...(value as object) }
            : value
        }
        const nextConfig = merged as unknown as InstanceConfig
        set((s) => ({
          instances: { ...s.instances, [id]: { ...cur, config: nextConfig, updatedAt: Date.now() } },
        }))
      },

      patchCmd: (id, index, patch) => {
        const cur = get().instances[id]
        const cmds = cur && cmdsOf(cur.config)
        if (!cur || !cmds || index < 0 || index >= cmds.length) return
        const next = cmds.map((c, i) =>
          i === index ? { ...c, ...patch, key: mergeNested(c.key, patch.key), image: mergeNested(c.image, patch.image) } : c,
        )
        // 判别式收窄在 set 回调里会失效，先在外部算好
        const nextConfig = withCmds(cur.config, next)
        set((s) => ({
          instances: { ...s.instances, [id]: { ...cur, config: nextConfig, updatedAt: Date.now() } },
        }))
      },

      setCmds: (id, cmds) => {
        const cur = get().instances[id]
        if (!cur || !cmdsOf(cur.config)) return
        const nextConfig = withCmds(cur.config, cmds)
        set((s) => ({
          instances: { ...s.instances, [id]: { ...cur, config: nextConfig, updatedAt: Date.now() } },
        }))
      },
    }),
    { name: 'autoplay.instances' },
  ),
)
