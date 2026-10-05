/**
 * 选区解析（工单 04 · ②③）。
 *
 * 把客服框住的客户消息，一次性解析出四类信息，供「一键查件」（单号）与
 * 「变量自动填」（人名 / 订单号）两处复用 —— 合成一个函数，避免两套正则
 * 各扫一遍选区、互相打架、对不齐。
 *
 * 这是**启发式**，不是 NLP：客服场景里形态固定（单号是顺丰/圆通那种字母数字串、
 * 人名是被标点/空格隔开的两三字中文、订单号紧跟「订单」二字）。
 * 抓不到就返回空数组，调用方据此保留占位符 / 不显示查件入口。
 */
import { parseWaybills } from '@/lib/logiInput'

export interface SelectionParse {
  waybills: string[]
  /** 像人名的 2-3 字中文（已排除礼貌词 / 称呼） */
  names: string[]
  /** 跟在「订单 / 单号」后的字母数字串 */
  orderNos: string[]
  /** YYYY-MM-DD / YYYY/MM/DD */
  dates: string[]
}

/** 礼貌词 / 称呼 / 业务词：即便凑巧以姓氏开头也不能当人名 */
const NAME_STOPWORDS = new Set([
  '您好', '亲爱', '亲', '客户', '先生', '女士', '师傅', '老板', '订单', '物流',
  '快递', '谢谢', '感谢', '我们', '你们', '他们', '已经', '这个', '那个',
])

// 常见姓氏（top ~100）：人名几乎一定以姓氏开头，用这一条把「单号 / 预计」之类
// 业务词挡在门外 —— 否则 {客户名} 会被填成「单号」。
const SURNAMES =
  '王李张刘陈杨黄赵周吴徐孙朱马胡郭林何高梁郑罗宋谢唐韩曹许邓萧冯曾程蔡彭潘袁于董余苏叶吕魏蒋田杜丁沈姜范江傅钟卢汪戴崔任陆廖姚方金邱夏谭韦贾邹石熊孟秦阎薛侯雷白龙段郝孔邵史毛常万顾赖武康贺严尹钱施牛洪龚'
// 人名后的常见衔接字：有了它们，名字后面跟「的 / 先生 / 女士」也算命中
// （否则「张三的」里 张三 后面是中文「的」，会被当成「名字还没完」而漏掉）
const NAME_TAIL = new Set(['的', '先', '女', '同', '老', '您', '：', '，', '。', '！', '？'])

// 订单号：紧跟「订单 / 订单号」的字母数字串（>=5 位）。
// 注意只认「订单」不认裸「单号」——「单号」在客服语境里几乎都是运单号，
// 那部分交给 parseWaybills 收进 waybills，这里若也抓会重复。
const ORDER_RE = /(?:订单[号码]?|order)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9_-]{4,})/gi
// 日期：YYYY-MM-DD 或 YYYY/MM/DD
const DATE_RE = /\b(\d{4}[-/](?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01]))\b/g
// 人名：以常见姓氏开头、后接 1-2 个中文；前面不能是中文（避免从「伟大的」里抠出名字）
const NAME_RE = new RegExp(`(?<![一-龥])([${SURNAMES}][一-龥]{1,2})`, 'g')

export function parseSelection(text: string): SelectionParse {
  const t = text || ''

  // 运单形状：2+ 字母打头 + 3 位以上数字（顺丰 SF123…、圆通 YT…），或 8 位以上纯数字。
  // 复用 parseWaybills 做分词，但**过滤形状**——否则「和 / 都在路上」也会被当成单号；
  // 含尾字母的（NO2026ABC 这种订单号）也不算运单，交给 orderNos 收。
  const WAYBILL_RE = /^[A-Za-z]{2}\d{3,}$|^\d{8,}$/
  const waybills = parseWaybills(t).filter((no) => WAYBILL_RE.test(no))

  const orderNos: string[] = []
  for (const m of t.matchAll(ORDER_RE)) {
    const v = m[1]
    if (v && !orderNos.includes(v)) orderNos.push(v)
  }

  // 统一成 YYYY-MM-DD：把 2026/10/09 这种斜杠写法规整成横杠，
  // 下游 CSV / 展示只认一种形态。
  const dates: string[] = []
  for (const m of t.matchAll(DATE_RE)) {
    const norm = m[1]?.replace(/\//g, '-')
    if (norm && !dates.includes(norm)) dates.push(norm)
  }

  const names: string[] = []
  for (const m of t.matchAll(NAME_RE)) {
    let v = m[1]
    if (!v) continue
    // 贪心可能把「的 / 先生 / 女士」这类衔接字也吃进来，剥掉尾部衔接字才是真名
    while (v.length > 2 && NAME_TAIL.has(v[v.length - 1])) v = v.slice(0, -1)
    if (v.length < 2) continue
    if (!NAME_STOPWORDS.has(v) && !names.includes(v)) names.push(v)
  }

  return { waybills, names, orderNos, dates }
}
