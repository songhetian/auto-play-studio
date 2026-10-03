import { hotkeyMapOf } from '@/lib/hotkey'
import type { Cmd, CompareField, Instance } from '@/schemas/instance'

/**
 * 读模型归一化（API 边界）。
 *
 * 引擎里存的是**历史版本写下的 JSON**：`columns`、`hotkeys` 这些都是后来才加的字段，
 * 老实例的 config 里根本没有它们。zod 的 `instanceConfigSchema` 是**校验**用的
 * （`excelPath` 为空就是非法），拿它来解析「还没配完的实例」会直接失败，
 * 所以这里只补字段、不判合法性 —— 合法性由配置页的校验去报错。
 *
 * 不做这一步的后果很具体：`rpa.columns.length` 会因 undefined 抛异常，整个配置页白屏。
 */
export function normalizeInstance(raw: unknown): Instance {
  const inst = raw as Instance
  // hotkeyMapOf 本身就做逐项回落，缺字段 / 值非法都能收拾干净
  const hotkeys = hotkeyMapOf(inst.config)

  switch (inst.config.tool) {
    case 'rpa': {
      const cfg = inst.config
      const columns = cfg.rpa.columns ?? []
      const cmds: Cmd[] = cfg.rpa.cmds ?? []
      return { ...inst, config: { ...cfg, rpa: { ...cfg.rpa, columns, cmds }, hotkeys } }
    }
    case 'macro': {
      const cfg = inst.config
      // cmds 是后来才有的字段：新建实例的存档里没有它，直接读 .length / .map 会白屏
      return { ...inst, config: { ...cfg, macro: { ...cfg.macro, cmds: cfg.macro?.cmds ?? [] }, hotkeys } }
    }
    case 'logi': {
      const cfg = inst.config
      return { ...inst, config: { ...cfg, logi: { ...cfg.logi, columns: cfg.logi.columns ?? [] }, hotkeys } }
    }
    case 'cmp': {
      const cfg = inst.config
      const primaryFields: CompareField[] = cfg.cmp.primaryFields ?? []
      return {
        ...inst,
        config: {
          ...cfg,
          cmp: {
            ...cfg.cmp,
            primaryColumns: cfg.cmp.primaryColumns ?? [],
            primaryFields,
            otherFiles: cfg.cmp.otherFiles ?? [],
          },
          hotkeys,
        },
      }
    }
    case 'monitor': {
      const cfg = inst.config
      return { ...inst, config: { ...cfg, rules: cfg.rules ?? [], hotkeys } }
    }
    default:
      return inst
  }
}

/** 列表接口用；非数组一律当空列表，避免半截数据把页面搞崩 */
export function normalizeInstances(raw: unknown): Instance[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeInstance)
}
