# 19 · 组合键语汇 + `macro` 按键精灵工具

Status: done
Priority: P0.5
Type: task
Blocked by: —

## 背景

用户原话：

> 那我是不是还需要一个 不需要传入 excel 也能支持一些操作的功能 就是类似按键精灵
> 还有就是那些操作要支持快捷键操作 比如 ctrl+c 这种 不要只是个按键

两个诉求要拆开看，因为它们是**两个不同层次**的问题：

1. **「按键要支持组合键」** —— 这是**指令层语汇**的问题。现状是 `CmdInspector` 里按键是**自由文本框**
   （`combo.join('+')` / `split('+')`，无任何校验），直接透传给 `pyautogui.hotkey(*combo)`。两种错法：
   - `Ctr+C` → `hotkey('Ctr', 'C')` 抛异常（能看见，还好）；
   - 写成一个串 `hotkey('ctrl+c')` → pyautogui 把**整串当成一个键名**，**静默什么都不做**。
   第二类是最难查的故障：界面显示配好了，跑起来「没反应」，没有任何报错。

2. **「不需要 Excel 也能干活」** —— 这是**工具入口**的问题。`rpa` 工具的必填项包含
   `excelPath` + 关键词列，没有表就走不下去（Zod 直接拦）。而客服日常大量动作是
   「在当前窗口按几下」——截个图、复制一段、切个标签页、填个单号——压根没有「一批数据」。

裁定（用户选定推荐项）：

- 按键精灵**做成新工具 `macro`**，不给 `rpa` 加「无数据源模式」。
  理由：`rpa` 的运行器假设「有一张表 + 逐行 + 回写状态」，塞一个空表路径进去会让
  `Runner`、进度条、`skipSuccess`、失败回写全部要为「没有表」分支出第二种语义 ——
  **一个工具一种心智模型**，比在一个工具里塞两套流程更省事。
- 组合键用**键位拾取器 + 白名单校验**，复用 `src/lib/hotkey.ts` 的 `accelFromEvent` 思路
  （但**语汇不同**，见下）。
- `macro` 的触发方式：手动 / 快捷键（这是 P0 #03 触发器底座的第一个真实用户）。

## 关键概念：两套键位语汇不能混

| 模块 | 语汇 | 用途 |
| --- | --- | --- |
| `src/lib/hotkey.ts` | **Electron accelerator**：`CommandOrControl` / `Super` / `Return` | 主进程注册**全局**快捷键 |
| `src/lib/keys.ts` | **pyautogui 词表**：`ctrl` / `win` / `enter` | 让**目标程序**替你按一下 |

两者长得像，混用会出现「录进去了但按不出来」。

## 已完成（第一片：组合键语汇）

- `python/engine/keys.py` —— `normalize_combo(raw) -> (combo, reason)`，指令层语汇的唯一真源。
- `src/lib/keys.ts` —— 第二实现：`normalizeCombo` / `comboFromEvent` / `comboToText` /
  `comboTokens` / `comboLabel`。
- `python/tests/fixtures/key_cases.json` + `src/lib/key.cases.json` —— 两份同内容黄金用例，
  由 `python/tests/test_shared_fixtures_parity.py` 看守（与工单 01 同一套做法）。
- `python/engine/commands.py` —— `_exec` 的 `key` 分支先归一化，`reason` 非空即抛 `CommandError`
  （整行失败，而不是静默不按）。
- `src/schemas/instance.ts` —— `key.combo` 加白名单校验，**保存时**就拦下编造的键名。
- `src/components/blocks/key-picker.tsx` —— 键位拾取器：录制 / 手写 / 常用快选 / 当场报错。
- 已肉眼验收（`.scratch/verify/`，明暗两套主题各 6 张，含「只按住修饰键」「录到 Ctrl+Shift+C」
  「手写 Ctr+C 报错」三个状态）。

词表里每个规范名都由 `python/tests/test_keys.py` 拿**真 `pyautogui.KEYBOARD_KEYS`** 断言 ——
这是独立真相源，凭印象编一个不存在的键名会立刻红。

### 归一化的语义约定

- 规范输出全小写；修饰键按 `ctrl → alt → shift → win` 固定顺序排在前，其余按键保持输入顺序。
  否则 `Shift+Ctrl+C` 与 `Ctrl+Shift+C` 会被当成两个键，没法比较。
- 空段一律丢掉：`Ctrl++C` ≡ `Ctrl+C`。
- **修饰键单独按下是非法组合**（不是合法单键）—— driver 会静默什么都不做。
- **`+` 是分隔符**，想按 Ctrl 加号必须写 `ctrl+plus`；标点键的规范名就是**单字符本身**
  （pyautogui 表里没有 `slash` / `period`）。
- `comboToText` 的输出必须能**再被 `normalizeCombo` 吃回去**，有测试看住。

### 拾取器踩到的坑

1. **`+` 本身就是 Shift+= 打出来的**。照搬 `shiftKey` 会让「Ctrl+加号」记成「Ctrl+Shift+加号」。
   规则：主键是「靠 Shift 打出来的非字母数字字符」时把 Shift 吃掉；字母/数字上的 Shift 保留。
2. **主键盘与小键盘的 `e.key` 相同**（都是 `'5'`），只能靠 `KeyboardEvent.code`（`Numpad5` → `num5`）区分。
3. 手写草稿非法时输入框里是错的那串，而配置里仍是旧键 —— 所以键帽行必须写清「实际生效：」，
   否则「输入框空着、配置里还有旧键」自相矛盾。

## 已完成（第二片：`macro` 工具）

### 引擎（`python/`）

- `engine/runner.py` 新增 `_run_macro`：激活绑定窗口 → 逐条执行 → **一条指令一行台账**。
  与 rpa 的根本区别是「没有数据源」：不读 Excel、不逐行、不回写状态列。
  - 关掉的指令（`on: false`）也占一行 `skip`，否则进度条永远差一格、用户看不出少了谁；
  - 某一步失败就停住，并让整轮以 `error` 收场 —— 断在第 2 条却显示「已完成」，
    客服会读成「这条回复发出去了」；
  - **没绑窗口直接拒绝执行**：没有目标窗口就等于往「此刻恰好在前台」的窗口里打字。
    这是误触发保护的最后一道闸（配置页拦得住正常保存，手工改过的 JSON 拦不住）；
  - 绑定的窗口**找不到**也整轮失败且一个键都不按（有测试看住这条）。
- `_run` 每轮开始把 `progress_done/total` 清零：中途退场的轮次不能顶着上一轮的数字。
- `engine/main.py` `DEFAULT_CONFIG` 加 `macro` 分支，四个旧工具的默认热键补上 `run: F8`。
- `engine/commands.py` `win` 指令标题解析为空时报错 —— 空串会匹配到**任意**窗口。
  rpa 里留空会回落到本行关键字所以碰不到；宏没有行，这条路真能走到。
- `engine/main.py` `/instances/{iid}/rows` 改回 camelCase（`rowNo/keyValue/durationMs`）。
  **这是一个一直存在的真缺陷**：引擎回 snake_case、前端读 camelCase，页面不报错，
  但整张「执行明细」的步数/关键字/耗时全是空白和 NaN —— rpa 也一样。
  现在有 `test_api.py::test_rows_endpoint_uses_the_frontend_field_names` 看住字段名。

### 前端（`src/`）

- `schemas/instance.ts`：`toolTypeSchema` 加 `macro`；`macroConfigSchema = { cmds }`；
  `instanceConfigSchema` 加 macro 分支（`window` 必填）。
  **刻意不设 `trigger`（触发方式）枚举** —— 触发就是这个实例的全局快捷键
  （`hotkeys.run`，默认 F8），已经真接上了主进程注册表；再加一个开关是同一件事两块开关。
- `stores/instanceStore.ts`：`setCmds` / `patchCmd` 的读写路径从写死 `rpa` 改为
  `cmdsOf(cfg)` 一个决定点（rpa / macro 各取自己的 `cmds`；其余工具静默忽略，
  绝不把 `cmds` 挂到配置根上）。
- `modules/instance/CmdFlowEditor.tsx`（新）：编排三列（指令库 / 序列 / 属性）抽成共用组件，
  rpa 与 macro 共用；数据源差异通过 `columns / sample / excelPath / hasDataSource` 表达。
  顺带删掉两个**假指令预设**：「标记结果」其实是延时、「窗口置顶」其实是激活窗口。
- `modules/instance/CmdInspector.tsx`：加 `hasDataSource`，宏不显示模板预览与变量按钮
  （宏没有列，预览里「上传 Excel 后可看到渲染效果」是做不到的承诺）。
- `modules/instance/RunPage.tsx`：macro 分支 —— 按钮「执行一次」、表头「步/指令」、
  不画分布饼图与耗时曲线、进度带「条指令」单位、状态徽标用中文（`STATUS_TEXT`）。
- `app/moduleRegistry.ts` + `app/navModel.ts`：注册「按键精灵」（执行类工具，红色，`ListOrdered` 图标）。
- `App.tsx` + `console/useInstances.ts`：**实例窗口自己拉实例列表**（此前只有控制台窗口在拉，
  实例窗口是独立渲染进程读不到那份缓存）→ 点了「开始执行」之后徽标/进度/明细永远停在那一下。
  这是又一个一直存在的真缺陷，macro 的验收标准把它顶了出来。有实例活跃时轮询收紧到 1.2s。
- `RunPage.tsx` 状态一变就重取明细与日志：最后一次状态跃迁不会自动带回收尾结果。

### 跨端一致性守卫（新）

`test_state_machine.py::test_engine_default_config_agrees_with_the_frontend`：
- 工具清单：`toolTypeSchema` ↔ `DEFAULT_CONFIG`（新工具漏登记一边立刻红）；
- 默认热键：`DEFAULT_HOTKEY_MAP` ↔ 每个工具的 `hotkeys`（加动作漏改引擎立刻红）。
这条守卫是本会话踩过「`registeredAccels` 硬编码两项」那类坑之后立的。

### 肉眼验收

`.scratch/verify/macro.cjs`（一次性脚手架，用完即弃）—— 明暗两套主题各 8 张：
`60-macro-window`（绑定窗口 + 怎么触发） / `61-macro-flow`（三列编排） /
`62-macro-inspector-text`（无模板预览） / `63-macro-inspector-key`（组合键拾取器） /
`64-macro-run`（逐条台账，步/指令/耗时） / `65-macro-run-error`（窗口找不到 → 异常 + 0/5） /
`66-rpa-flow`（抽取组件后的 rpa 回归） / `67-settings-hotkeys`（三个动作的列）。
探针断言：宏的编排页不出现 Excel 模板预览；设置页热键表必须有「开始执行」列。
点「执行一次」是**真点**：绑定窗口用了必然不存在的标题，验证的是
「整轮失败且一个键都不按」这条误触发保护，不往任何真实窗口打字。

## 验收标准

- [x] 指令里的按键支持组合键（`Ctrl+C` 这种），不是只能单键
- [x] 键名写错**当场**报错，不是跑起来静默不按
- [x] 归一化结果前后端一致（同一份黄金用例两侧跑）
- [x] 新建一个 `macro` 实例不需要任何 Excel，配置「绑定窗口 + 按 Ctrl+C + 按回车」即可保存
- [x] 点「执行一次」能跑，运行页显示逐步日志而不是进度条
      （台账粒度 = 一条指令一行；顺带修好了明细表全空白的字段名失配）
- [x] 宏执行中可以中断（暂停/停止检查落在每条指令之前；单条 `flow` 延时期间停不住，
      代价换来「每条指令都是原子的」）
- [x] 快捷键触发**不是**留字段位，而是真接上了：F8（默认）系统级注册 →
      主进程按确定性规则路由到本实例 → RunPage 的 `run` 分派启动。
      比原计划（未接调度前禁用）更进一步，且没有为此加任何假开关。

## Comments

- 2026-10-02 第一片（组合键语汇）完成。护栏：后端 `387 passed` / 前端 `411 passed` / 双端
  `typecheck` 干净。肉眼验收见 `.scratch/verify/5*-picker-*.png`（明暗各一套，共 12 张）。
- 建成新工具而不是给 `rpa` 加无数据源模式，理由写在「背景」一节 ——
  核心是**别让 `Runner` 的「有一张表 + 逐行 + 回写状态」假设出现第二种语义**。
- 2026-10-02 第二片（macro 工具）完成。护栏：后端 `403 passed` / 前端 `419 passed` /
  双端 `typecheck` 干净。肉眼验收见 `.scratch/verify/6*-*.png`（明暗各 8 张）。
  顺带修掉两个一直存在的真缺陷：明细表字段名失配（全空白/NaN）、实例窗口不刷新状态。
