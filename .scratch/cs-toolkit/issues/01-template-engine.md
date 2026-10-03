# 01 · 模板与格式化引擎

Status: done
Priority: P0
Type: task
Blocked by: —

## 背景

`python/engine/commands.py:26` 已有 `render_template()`，支持 `{列名}` 引用当前行 Excel 数据，
且设计哲学是对的：**占位符解析不出来就抛 `CommandError` 让整行失败** —— 因为继续执行会把 `{客户名}`
这种字面量直接发给客户，那是真实事故。

但它只做字符串替换，没有格式化能力。客服实际要的是「输入订单号+金额 → 输出固定格式的登记文本」，
并且金额要千分位、要人民币大写、手机号要脱敏。

## 目标

支持 `{列名|格式化器}` 语法。**必须向后兼容**：旧模板不含 `|`，正则 `\{([^{}]*)\}` 一个字都不用改，
老配置全部照常工作。

```
订单号：{订单号}
金额：{金额|money}
大写：{金额|rmb}
手机：{手机号|mask}
下单：{下单时间|date:MM-DD HH:mm}
```

## 格式化器清单

| 名称 | 说明 |
| --- | --- |
| `money` | 千分位 + 两位小数；能处理 `1,234.56` / `¥99` 这类脏输入 |
| `rmb` | 人民币大写 |
| `mask` | 手机号 / 身份证 / 姓名自动识别脱敏，可 `mask:id` `mask:phone` 强制 |
| `date:格式` | `YYYY MM DD HH mm ss` 任意组合 |
| `cut:n` | 按长度截断加省略号 |
| `pad:n` | 左补零到 n 位 |
| `upper` / `lower` / `trim` | 大小写与去空格 |
| `default:x` | 空值兜底 |

## 已完成的准备工作

格式化器逻辑已在本地用 node 跑通验证，**18 个边界用例全过**（参考实现暂存在 `.tmp-tpl/fmt.mjs`，
需要正式落到代码里）。

⚠️ `rmb` 第一版写错过：`10000` 会输出成「壹零万元」，分组进位逻辑有 bug。修正后：
`0→零元整`、`0.5→伍角`、`100.05→壹佰元零伍分`、`10001→壹万零壹元整`、
`20000000.07→贰仟万元零柒分`、`1000000000.01→壹拾亿元零壹分`。
**这类函数靠肉眼看不出来，必须拿边界值打表。**

## 关键设计约束：前后端不能各写一份然后漂移

前端要做实时预览，所以渲染逻辑两端都需要。**两份实现必然会漂移。**

方案：把「语法 + 格式化器语义」写成一份规范，两端各实现一遍，
并用**同一组黄金用例 fixture** 在两侧都跑测试（Python 侧 pytest、前端侧 vitest 读同一个用例文件）。
任何一侧改了语义，另一侧测试立刻红。

## 验收标准

- [x] 旧模板（无 `|`）行为完全不变，有回归测试
- [x] 未定义列仍然整行失败，报错文案含列名
- [x] 每个格式化器都有边界用例（含 `rmb` 的分组进位、`0`、纯小数、负数）
- [x] 前后端共用同一组黄金用例，两侧测试都跑它
- [x] **保存模板时校验引用的列存在**（现在只有跑起来才发现「没有这一列」）
- [x] 配置页有实时预览：用某一行数据渲染，未定义字段当场标红
      —— 2026-10-02 截图验收过（12 镜头 ×2 主题，`.scratch/verify/run-tpl.sh`）。
      **验收抓出两个真缺陷，都已修掉**，见 Comments 〈界面验收抓出的两个真缺陷〉。

## 涉及文件

- `python/engine/commands.py`
- `python/engine/template.py`（新增）
- `python/tests/`
- `src/lib/template.ts`（新增）
- `src/schemas/instance.ts`
- `src/modules/instance/ConfigPage.tsx`

## Comments

### 落地方案（TDD，先确认 seam 再写测试）

**用户裁定的四个 seam**
1. 主 seam = `render_template(text, row)` 单一口径，格式化器内部实现保持私有 ——
   用户写的是 `{金额|rmb}`，不是 `rmb()`。测内部函数等于把测试焊在实现上，重构就红。
2. 黄金用例 = **两份副本 + 一致性守卫测试**（不跨目录 import，生产代码谁都不读它）。
3. 保存时校验 = **两边都做**：前端纯函数即时反馈，引擎按真表头复核。
4. 兼容退路 = **保留**：先按竖线左边当列名查，查不到再拿整串原文查一次，
   于是「列名里真的带 `|`」的老配置不会失效。

**新增文件**
- `python/engine/template.py` —— 模板语法唯一真源。`_render_one()` 是解析的唯一出口，
  `render_template`（渲染）与 `template_issues`（保存时校验）都走它 ——
  **于是「跑起来会失败」与「保存时说会失败」必然说同一句话**，不存在两套解析器。
- `src/lib/template.ts` —— 第二实现，逐条对齐语义**和报错文案**（文案也是契约）。
- `python/engine/template_routes.py` —— `POST /api/template/check`，
  拿 `excel.detect_columns()` 现读真表头（前端只有上传时的列缓存，换过 Excel 就不作数）。
- `src/components/blocks/template-preview.tsx` —— 实时预览：标红写错的占位符 + 显示渲染结果
  + 一个「用真表头复核」按钮。
- `src/lib/template.cases.json` ↔ `python/tests/fixtures/template_cases.json` —— 同内容两份副本。
- `python/tests/test_template.py` / `src/lib/template.test.ts` —— 两侧跑同一组用例。
- `python/tests/test_template_cases_parity.py` —— 守卫副本一致。
- `python/tests/test_template_api.py` —— 接口层。

**用例结构**：`render`（语法与集成，13 条）· `format`（格式化器边界打表，87 条）·
`issues`（保存时校验，9 条）· `errors`（必须整行失败，14 条）。每条带稳定 `id`。

**切片顺序**（每片先红后绿）：S1 兼容 → S2 `money`（打通解析层 + 注册表 + 报错路径）→
S3 `rmb` → S4 `mask` → S5 `date` → S6 `cut/pad/upper/lower/trim/default` →
S7 前端第二实现 → S8 保存时校验 + 接口 + 预览。

### 期间发现并修掉的坑

1. **`pad` 的参数校验必须先于空值判断** —— 否则 `{订单号|pad:abc}` 在空单元格上会被放过，
   而保存时的 dry-run 正是拿「值都为空」的行跑的，等于漏检。
2. **金额走字符串精确转「分」，不过 `Number`** —— `Number('1.005')` 是 1.0049999…，
   而 Python 的 `Decimal('1.005')` 是精确值，直接四舍五入会一个进位一个不进。
   这条结果是要发给客户的，所以两端的 `toCents` 都只做字符串运算。
3. **`-0.001` 不能输出 `-0.00`** —— 统一按「取绝对值后判负零」处理，两端一致。
4. **`None` 视作空串，但空串仍进格式化器** —— 否则 `str(None)` 会让 `{备注|mask}` 输出 `N***e`；
   而全部拦下又会把 `default:x` 挡掉。
5. **列名为空集时不校验** —— 用户还没上传 Excel 就不知道有哪些列，硬校验只会报一堆假警。
6. **已知跨语言分歧**（写进用例文件的 `_known_divergence`）：整数值浮点没法对齐，
   Python `str(100.0)='100.0'` 而 JS `String(100.0)='100'`。用例里禁止出现整数值浮点。

### 没做的（刻意）

- 不支持链式格式化器 `{金额|money|trim}` —— 会报「未知的格式化器「money|trim」」。报错是安全的那一侧。
- `date` 不接受 `02/10/2026` 这种歧义格式，也不做时区换算。猜错的日期会变成客户投诉。
- `mask` 的 auto 识别只认 11 位手机号与 15/18 位身份证，其余按姓名处理。

### 还需要人看一眼

~~配置页的预览界面（标红 / 渲染结果 / 复核按钮）没有肉眼验过~~ → 2026-10-02 验收完成，工单关闭。

### 界面验收抓出的两个真缺陷（2026-10-02）

验收脚本：`.scratch/verify/{seed_tpl.py,tpl.cjs,run-tpl.sh}`，6 镜头 ×2 主题 = 12 张。
冷启动直连 `#/instance/{id}/config`（旧 harness 都是先开控制台再切 hash，store 已有数据，走不到冷启动路径）。

**① 配置页冷启动白屏（React #310）** —— `ConfigPage.tsx` 的 `windowOptions` 这个 `useMemo`
写在 `if (!inst) return` **之后**。实例数据从 store 异步来：冷启动第一次渲染 `inst` 是 undefined
（走早退、hook 少），数据到了再渲染 hook 变多 → React 直接抛
"Rendered more hooks than during the previous render"，整棵树不渲染，用户看到一片白。
以前从没暴露，是因为 zustand-persist 从 localStorage **同步**恢复，
只要这个窗口之前列过实例，第一次渲染 `inst` 就有值。
修法：把 `useMemo` 挪到早退之前，让它容忍 `inst` 为空。守卫 = 验收脚本本身就是冷启动。

**② 「未定义字段当场标红」从来没生效过** —— 标红逻辑原来内联在 `TemplatePreview` 里，
判定喂的是**剥掉花括号的片段**（`金额|money`），而 `templateIssues` 只认带花括号的写法 →
`bad` 永远 false，红字一个都没有；下面的报错列表却照常有内容。
「文字对、样式错」是只读 innerText 的验收发现不了的 —— 这正是它漏网的原因。
修法：抽成 `src/lib/template.ts` 的 `templateParts(text, columns)`（入参是**整段模板**），
4 条单测锁住；组件只负责画。**先红后绿**（`templateParts is not a function` → 127 全过）。

验收里另有一条值得留着的证据链：〈列缓存过期〉那一镜，本地预览照常渲染出 `1,234.50`
且一个红字都没有，而引擎按真表头复核说没有这一列 —— **反过来证明那条报错来自引擎**：
如果它是本地校验报的，按组件逻辑就不会给出渲染结果。

数字：后端 644 / 前端 454（+4）/ typecheck 干净 / 12 镜头 ×2 主题全过。
