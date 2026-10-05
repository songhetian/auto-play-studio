# Motion Kit 专业评审

> 评审对象：`designs/motion-kit.html`（955 行，单文件原型）  
> 对照基线：`tailwind.config.js`、`src/styles.css`、`src/lib/color.ts`、`src/lib/motion.ts`、`src/lib/theme.ts`、`src/stores/themeStore.ts`、`src/components/ui/*`、`src/components/icon.tsx`  
> 评审方式：源码静态审查 + 按 WCAG 2.1 sRGB 相对亮度公式计算对比度。本报告不修改原型文件。

## 1. 判定结论

**结论：未达到可直接落地标准；可保留为概念演示，但不得原样并入 `src/`，也不应作为生产页面发布。**

主要原因不是视觉偏好，而是存在明确的功能、无障碍和集成阻断项：

1. `#anim-proxy` 的字符串替换会破坏带伪元素或后代选择器的规则，能把本应施加给 `::before`/子元素的 transform 动画误施加到按钮本体；这是当前页面的实际行为错误。
2. “暂停动画”不能暂停 7 类伪元素动画，属于假控制。
3. 浅色主题的全部 `text-muted` 小字号正文均未达到 4.5:1，最差只有 2.92:1；暗色品牌按钮的白字只有 3.84:1。
4. 悬停动效没有键盘等价触发，搜索框和兜底文本框明确移除了 outline，页面没有项目约定的 focus ring。
5. 复制反馈、筛选状态、暂停/主题状态、手写弹窗均缺少完整语义。
6. 原型令牌的命名、值格式和暗色选择器都与主项目冲突；复制/下载出的 CSS 也没有携带两套主题令牌。
7. `ico-flip` 的手写 hover 代理绕过了 `prefers-reduced-motion`。
8. `tx-swap` 仅悬停就显示“已复制”，与真实复制结果无关，违反“不做假开关/假状态”的原则。

**P0 必修项共 8 项**，见下方问题清单。P0 清零、关键动效重新定时并通过键盘/主题/减弱动效回归后，才可进入落地验收。

### 做对的部分（但不足以抵消阻断项）

- 18 个片段都有各自的 `prefers-reduced-motion` 分支；主体 keyframes 确实没有动画化宽高、margin、padding、top/left 等布局属性。
- 预览与复制读取同一份 `it.css`，避免了“展示 CSS”与“复制 CSS”手工维护两份的常见漂移。
- 加载器主要使用 transform/opacity，旋转统一用 linear；`btn-fill` 明确设计了离开时的回落。
- 主题变量的浅/暗值在本独立页面内部大体成对存在。

---

## 2. 问题清单

| 级别(P0必修/P1建议/P2可选) | 维度 | 位置(行号或类名) | 问题描述 | 修改建议 |
|---|---|---|---|---|
| P0必修 | CSS 架构/正确性 | 783–787，`#anim-proxy` | `replaceAll(it.root + ':hover', ...)` 不是 CSS 选择器变换。例：`.btn-sheen:hover::before` 会变成 `.btn-sheen:hover, .stage… .btn-sheen::before`，第一支丢失 `::before`，于是 `btn-sheen` keyframe 被施加给按钮本体；`btn-fill`、`btn-trace` 同类。`.tx-swap:hover .tx-swap-a` 则变成“按钮本体 + 代理下子元素”，按钮本体会收到文字动画。 | 禁止文本替换选择器。每个 hover 片段显式写 `:is(.root:hover, .stage[data-anim="id"]:hover .root)`，伪元素应写成 `:is(... )::before`；或用 JS 给根节点切 `data-preview-active`，CSS 只匹配状态属性。为所有代理规则加回归测试。 |
| P0必修 | 控件真实性/性能 | 102–104、926–931，`.is-paused` | `body.is-paused .stage *` 匹配不到伪元素，且 `animation-play-state` 非继承。`btn-sheen::before`、`btn-fill::before`、`btn-trace::{before,after}`、`btn-glow::before`、`ld-orbit::{before,after}`、`ld-skeleton i::after`、`st-dot::{before,after}` 共 7 类仍继续播放。按钮文案却显示“继续动画”。 | 补 `.stage *::before, .stage *::after`；更稳妥的是在卡片根设置 `data-paused` 并让每个动画选择器显式消费。按钮同步 `aria-pressed`。增加覆盖 18 项（含伪元素）的暂停清单测试。 |
| P0必修 | Reduced motion | 448、465–466、782–787，`ico-flip` | `ico-flip` 使用手写 `proxy`，代理动画规则在媒体查询外；减弱动效模式下，直接 hover wrapper 会降为 opacity，但 hover 整个 stage 仍执行 700ms 的 Y 轴翻转。18 项“都有降级分支”并不等于实际代理路径全部被覆盖。 | 把代理规则与 reduced 规则放进同一显式样式定义；减弱模式下 stage hover 也只改 opacity/颜色。测试 direct hover 与 stage proxy 两条触发路径。 |
| P0必修 | 对比度 | 42、67、121、130、133–146、154、158、171、189、221/254/308/332、794–815、903 | 浅色 `--muted #86909c` 对 canvas 3.05:1、对白底 3.24:1、对 stage 2.92:1，所有 10.5–13px 次要文字均未达 4.5:1。活动 tab 的品牌字/10% 品牌底为浅色 4.25:1、暗色 4.44:1；代码字/代码底为浅色 4.37:1、暗色 4.24:1；暗色白字/`#3b7bff` 只有 3.84:1；浅色复制成功绿字/白底只有 2.78:1。 | 不在原型另调一套颜色，直接复用主项目 `foreground`、`muted-foreground`、`primary-foreground`、`ok` 语义令牌，并对实际叠色后的组合写 `contrastRatio` 测试。小字号正文按 4.5:1；不要以“次要”作为降到 3:1 的理由。暗色主按钮需加深底色或换合格前景色。 |
| P0必修 | 键盘/焦点 | 133–146、180–184、216–764、792–817 | 页面控件没有项目统一的 `focus-visible` ring；`#search` 与 `#modal-code` 还明确 `outline-none`。所有 hover 型片段只响应鼠标，键盘聚焦不能预览。预览按钮虽能 Tab 到，却没有一致的可见焦点与 focus 触发。 | 并入主项目时只用现有 `Button`、`Input`、`Textarea`、Radix 控件；原型若保留，给所有交互控件统一 `focus-visible:ring-2 ring-brand`，输入容器用 `focus-within`。hover 动效统一提供 `:focus-visible` 等价路径；纯装饰预览不应进入 Tab 序。 |
| P0必修 | ARIA/弹窗/反馈 | 135、143–146、176–189、789–817、850–910、926–947 | toast 无 `role=status`/`aria-live`；复制后只改按钮文本，不保证被读屏宣告。手写 modal 无 `role=dialog`、`aria-modal`、标题关联、焦点圈、焦点陷阱与关闭后焦点恢复。筛选按钮无 `aria-pressed`/tab 语义；搜索仅有 placeholder；暂停与主题未暴露当前状态，主题 `aria-label` 也是静态的。 | 并入主项目复用现有 Radix `Dialog`、全局 `Toaster`、`Button`、`Input`、`Tabs/ToggleGroup`。独立页至少补 dialog 语义与焦点管理、`role=status aria-live=polite`、搜索 `aria-label`、筛选/暂停/主题状态属性及动态 label。 |
| P0必修 | 主项目集成/主题令牌 | 9–84、165、217–764、914–923 | 原型用 `.dark` + `rgb(--*-rgb)`，主项目用 `[data-theme=dark]` + `hsl(var(--x))`。更严重的是同名变量含义冲突：原型 `--muted/#hex`、`--card/#hex`、`--ok/#hex` 是完整颜色，主项目同名变量是 HSL 通道；复制 `.ico-arrow { color: var(--muted) }` 或 `.st-dot { background: var(--ok) }` 到主项目会成为无效颜色。下载文件又不含原型的 `:root/.dark` 变量，所谓“复制即用、支持双主题”不成立。 | 不能拷贝原型 token 块。统一映射为 `background/card/accent/border/foreground/muted-foreground/primary/primary-foreground/ok`，CSS 中写 `hsl(var(--token))`，主题只由现有 `themeStore` 和 `data-theme` 管理。导出的内容若保留，要么是主项目 `animate-*` 类配方，要么连同自包含、命名空间隔离的 token 一起导出。 |
| P0必修 | 产品语义 | 731–764，`tx-swap`；216/248/286/326/363 等预览按钮 | `tx-swap` 在 hover 时直接把“复制 CSS”换成“已复制 ✓”，没有任何复制动作，是虚假成功反馈；多个预览 `<button>` 可被键盘激活但没有动作。 | `tx-swap` 改为由真实 `copied` 状态驱动，仅复制 Promise 成功后切换；失败进入 Dialog。纯视觉预览若没有动作应改非交互容器并移出 Tab 序，或给它真实的“播放/重播”消费方。 |
| P1建议 | 动效曲线/时长 | 323–357、652–675、731–763，`btn-trace`/`tx-rise`/`tx-swap` | 三者把极前重的 `cubic-bezier(.22,1,.36,1)` 用在 420–1800ms 的悬停/往复位移上：前段几乎瞬间完成，尾段拖长，观感是“闪一下再等结束”。`btn-trace` 和 `tx-swap` 离开时还直接跳回初态。 | 悬停 160–240ms `ease`；成对移位 180–260ms `ease-in-out`；需要入场的单次动作才用 `.22,1,.36,1`，且控制在 160–260ms。为 unhover 明确定义反向 transition，退出约比入场快 20%。 |
| P1建议 | 动效本体 | 469–499，`ico-arrow` | 它实际使用 `.65,0,.35,1`，**不是** `.22,1,.36,1`，没有同类极前重“闪”问题；但 1.3s 无限循环只适合短时引导，若常驻于高频入口仍会持续抢注意力。 | 保留当前 ease-in-out 方向运动，但只在 onboarding/短时引导状态挂载；看到一次或状态完成后停止。 |
| P1建议 | 页面入场 | 97–100、801–805，`.cat-in` | 420ms 已超出项目 `src/lib/motion.ts` 规定的 160–260ms；18 卡 × 30ms 延迟且延迟封顶 420ms，索引 14–17 四张卡同时入场，总尾长 840ms。`pending` 类从未使用。 | 复用 `fadeItem`（180ms）/`staggerList`（35ms），只动画首屏可见项；大列表或频繁进入页面可直接不做 stagger。删除死的 `.pending`。 |
| P1建议 | Reduced motion | 105–109，`*` 全局规则 | `* { transition-duration:.01ms !important }` 粗暴影响页面所有组件和未来第三方控件；只改 duration、不清 delay，也不覆盖伪元素或 Web Animations。它把本应保留的颜色反馈变成瞬切，并制造大量 `!important` 优先级债务。 | 对自有组件用 `motion-reduce:transition-none`/局部媒体查询；CSS 动画逐项降级，JS/Motion 使用 `useReducedMotion`。不要在集成页保留全局星号兜底。 |
| P1建议 | Reduced motion/加载语义 | 531–559，`ld-orbit`/`ld-comet` | 3s/圈而非完全停止并非绝对错误：加载中的持续性是重要语义，低速、线性、低位移旋转通常可以接受。但 `ld-orbit` 的降级 shorthand 把内外圈都重置为同方向同速度，且双圈仍属非必要运动；两个 loader 都没有文本/`role=status`。 | 减弱模式优先保留一个 3s 单环或改静态进度图形，并始终配合真实加载文案、`role=status`/`aria-busy`。允许用户手动“暂停”时必须真的暂停。 |
| P1建议 | 性能 | 224–225、265–266、304–305、432–433、566–579、600–605 | `will-change` 永久挂在 hover 按钮、常驻心跳、5 根 bars 和 track 上，页面加载后长期保留约 10 个合成层候选。小元素无需提前占层，尤其 hover 动画。 | 默认删除；只有经性能剖析确认且即将播放时，通过临时状态类在播放前添加、结束后移除。无限 loader 也先让浏览器自动提升。 |
| P1建议 | 主题完整性/字面量 | 35–84、221、254、263、308、332、341、384、549–550、634 | `--sk-hi` 从未在浅/暗主题定义，暗色仍使用 `rgba(255,255,255,.75)`，高光过亮。白字、白色描边、高光和黑色 mask 多处写死。mask 黑色属于技术值可保留，但文字/高光应语义化。`brand2` 紫色也不在项目唯一主色口径内。 | 定义经两主题校验的 skeleton highlight，或由 `foreground` 低 alpha 派生；按钮前景使用 `primary-foreground`；删除未经批准的 `brand2`，确有真实语义再新增命名 token。 |
| P1建议 | Tailwind/部署纪律 | 7–31、118–189 | Play CDN 3.4.16 与项目包 3.4.7/真实配置脱节，且 Tailwind Play CDN 明确适合开发演示，不适合生产；外链脚本、内联 script/style 和动态 style 注入也不利于 Electron CSP/离线发布。“单文件零依赖”描述不准确。 | 保留在 `designs/` 可接受；生产必须走 Vite + 本地 Tailwind 编译，应用真实 config，不引入远程脚本，不放宽 CSP 到 `unsafe-inline`。 |
| P1建议 | 组件复用 | 133–146、175–189、203–208、789–819 | 页面重做 Button、Input、Dialog、Toast、Tabs，并内联 SVG；并入主项目将绕过 `src/components/ui/` 与唯一 `Icon` 入口。 | React 化时直接复用现有组件。只把“动效行为”作为 variant/包装器增加，不复制基础控件结构和样式。 |
| P1建议 | Tailwind 用法 | 121–189、792–819、903–904 | 大量 `text-[10.5px]/[11.5px]/[12.5px]` 重复主项目已经定义的 `text-2xs/xs/sm`；颜色命名与 shadcn 语义冲突。`!border-ok !text-ok` 用 important 压状态，是状态建模不足的信号。 | 改语义字体/颜色类；复制成功使用 `data-state=copied` 或 React state + `cn`，不要用 important 逃逸。 |
| P1建议 | 动效规范/陈述一致性 | 130、224、257、296、803、189 | 页面声称“只用 transform/opacity”，实际过渡了 `filter`、`color`、`border-color`、`box-shadow`，toast 还使用 `transition-all`。没有 keyframe 动画 layout 属性，但宣传表述不准确，`transition-all` 会让未来新增属性意外动画。 | 改文案为“关键位移动画只用 transform/opacity”；代码显式列举需过渡的属性，删除未变化的 `box-shadow` 和 `transition-all`。 |
| P1建议 | 主题行为 | 933–952 | 独立页首次跟随系统，但手动切换后只能持久化 light/dark，无法回到项目已有的 `system` 三态；系统运行时切换仅 CSS 会响应，横幅不会动态更新。 | 并入主项目直接使用 `themeStore`；独立页若保留，支持 light/dark/system，并监听 `matchMedia` 的 `change` 更新横幅和 aria 状态。 |
| P2可选 | CSS 维护性 | 529、554，`@keyframes ld-spin` | 同名同内容 keyframe 在最终注入/下载 CSS 中重复两次；当前不改变结果，但增加体积并使未来修改可能出现先后覆盖。 | 提取为共享 keyframe，只输出一次；下载时按 keyframe 名去重。 |
| P2可选 | 文案准确性 | 245–280、283–320 | `btn-sheen` 文案说“匀速”，实际用标准 ease-in-out；`btn-fill` 标注“匀加速”，实际 `.32,.72,.24,1` 是强 ease-out 倾向。 | 要么改为 linear/符合描述的曲线，要么修正文案，不能让片段标签误导使用者。 |

---

## 3. CSS 架构专项结论

### 3.1 “CSS 字符串作为唯一真源”是否成立

**在独立演示页范围内，取舍部分成立；在主项目生产代码中不成立。**

成立的部分：

- `anim-css.textContent = ITEMS.map(it.css)` 保证浏览器执行的基础片段与复制出的基础片段相同。
- 使用 `textContent` 注入静态常量，没有 `innerHTML` 注入 CSS 的额外 HTML 解析风险。

不成立或不完整的部分：

- “实际预览 CSS”还叠加了第二份 `anim-proxy` 派生 CSS；基础字符串相同，但选择器被错误改写后，预览行为已不同于复制内容。
- DOM 结构 `it.html` 与 CSS `it.css` 仍是两份字符串，没有 schema/测试确认 `root`、结构和选择器一致。
- CSS 藏在 JS template literal 中，失去 CSS lint、编辑器选择器检查、构建期压缩、按需产物和 CSP 友好性。
- 每个 hover 项的完整 CSS 被再次写入 `#anim-proxy`，连 keyframes 和 media query 一并重复，不只是附加一条代理规则。

若仍要保留“预览即复制”的开发工具，建议将片段放入独立 `motion-snippets.css`，Vite 中一边正常 `import` 应用，一边用 `?raw` 读取同一文件供复制；hover 代理必须是显式选择器，不能对 CSS 文本做替换。若只是把动效用于产品，则不需要复制功能，直接将获批 keyframes 放入 Tailwind 配置。

### 3.2 代理错误的具体展开

当前算法把：

```css
.btn-sheen:hover::before { animation: btn-sheen ... }
```

展开为等价于：

```css
.btn-sheen:hover,
.stage[data-anim="btn-sheen"]:hover .btn-sheen::before {
  animation: btn-sheen ...;
}
```

第一支选择器不再带 `::before`，因此按钮本体执行 `skewX/translateX`。正确结构应是：

```css
:is(
  .btn-sheen:hover,
  .stage[data-anim="btn-sheen"]:hover .btn-sheen
)::before {
  animation: btn-sheen ...;
}
```

同理，后代选择器必须把状态放在父节点而不是用逗号截断后缀：

```css
:is(
  .tx-swap:hover,
  .stage[data-anim="tx-swap"]:hover .tx-swap
) .tx-swap-a { /* ... */ }
```

---

## 4. 设计令牌与主题

### 4.1 原型到主项目的映射

| 原型 | 主项目应使用 | 风险 |
|---|---|---|
| `canvas` | `background` | 原型自造角色名 |
| `surface` / `card` | `background` / `card` | `--card` 与主项目同名但值格式不同 |
| `stage` | `muted` 或 `accent` | 不应新增只服务预览台的全局 token |
| `line` | `border` / `input` | 名称不一致 |
| `ink` / `fg` | `foreground` / `card-foreground` | 重复语义 |
| 原型 `muted`（文字） | `muted-foreground` | 与主项目 `muted`（背景）语义相反；直接拷贝最危险 |
| `brand` | `primary` | 主项目 `brand` 没有 DEFAULT，`bg-brand` 无法原样使用 |
| `brand2` | 原则上删除 | 项目只有一个主色；只有真实第二语义才新增 token |
| `ok` | `ok`，但必须写 `hsl(var(--ok))` | 主项目变量是 HSL 通道，不能裸用 `var(--ok)` |
| `dot` / `code-bg` | 由 `foreground` / `primary` alpha 派生 | 无需再维护两主题字面量 |
| `shadow` | 组件已有 `shadow-*` 或统一 elevation | 不应由此页面新增一套阴影系统 |

### 4.2 硬编码颜色审计

- `#fff`：按钮前景（221、254、308、332）和 surface fallback（384、741）。按钮前景必须改 `primary-foreground`，否则暗色品牌底对比度失败。
- `rgba(255,255,255,.5/.9)`：sheen/trace 装饰（263、341）；可作为效果 alpha，但应基于前景 token，避免只适配深色按钮。
- `#000`：mask（549–550）；这是遮罩 alpha 技术值，不参与主题，可保留并注释。
- `--sk-hi` fallback（634）：变量未定义，实际永远落到白色 75%；必须补两主题或从语义前景派生。
- `#165DFF/#7C3AED/#E5E6EB/#86909C/#00B42A/#1D2129`：作为“粘贴即用” fallback 可以解释，但原样进入主项目会绕过语义 token，其中 `#7C3AED` 还引入了未批准的第二品牌色。
- `bg-black/40`（176）：遮罩本身合理，但主项目已有 DialogOverlay，不应复制实现。

---

## 5. 对比度计算

### 5.1 方法

采用项目 `src/lib/color.ts` 同一公式：

- sRGB 通道线性化：`s <= 0.03928 ? s/12.92 : ((s+0.055)/1.055)^2.4`
- 相对亮度：`L = 0.2126R + 0.7152G + 0.0722B`
- 对比度：`(Lmax + 0.05) / (Lmin + 0.05)`
- 半透明背景先按 `C = α·foreground + (1-α)·background` 合成再计算。

### 5.2 结果

| 组合 | 浅色 | 暗色 | 结论（小字号文字 4.5:1） |
|---|---:|---:|---|
| ink / canvas | 15.18:1 | 15.53:1 | 通过 |
| ink / surface | 16.13:1 | 14.38:1 | 通过 |
| ink / stage | 14.53:1 | 15.06:1 | 通过 |
| muted / canvas | **3.05:1** | 6.11:1 | 浅色失败 |
| muted / surface/card | **3.24:1** | 5.66/5.52:1 | 浅色失败 |
| muted / stage | **2.92:1** | 5.92:1 | 浅色失败，且低于 3:1 |
| brand / canvas | 4.89:1 | 4.92:1 | 通过 |
| brand / surface | 5.19:1 | 4.56:1 | 通过，暗色余量很小 |
| brand / 10% brand + canvas（活动 tab） | **4.25:1** | **4.44:1** | 两套失败 |
| brand / code-bg（8%/14% 品牌叠底） | **4.37:1** | **4.24:1** | 两套失败 |
| white / brand（按钮文字） | 5.19:1 | **3.84:1** | 暗色失败 |
| ok / surface（复制成功文字） | **2.78:1** | 7.47:1 | 浅色失败 |
| line / surface（边界） | 1.25:1 | 1.24:1 | 若边框是控件唯一边界，远低于非文本 3:1 |

失败文字覆盖页头说明、非活动筛选、搜索 placeholder、空态、落地约定、footer、卡片描述、trigger chip、duration/ease chip、暗色预览主按钮和浅色复制成功态，不是孤立一处。

---

## 6. 18 个动效逐项核对

| ID | 当前参数 | 结论 | 落地建议 |
|---|---|---|---|
| `btn-jelly` | 420ms，`.22,1,.36,1`，press | 回弹曲线用于低频点击有理由，但总尾巴偏长；hover 也用极前重曲线，永久 `will-change` 不值。主项目已有 `active:scale-[.98]`，大多数按钮不需要它。 | 只给极低频主操作；压到 260–320ms，移除常驻 will-change；普通按钮维持现有 active scale。减弱模式补独立 active 颜色反馈。 |
| `btn-sheen` | 900ms，标准 ease-in-out，hover | 装饰可慢于 300ms，但“匀速”与实际曲线不符；代理当前会让按钮本体执行 keyframe。离开时高光在裁剪区外复位，回落本身可接受。 | 修代理；若强调扫光匀速用 linear，650–900ms；仅低频强调入口使用。 |
| `btn-fill` | 520ms，`.32,.72,.24,1`，hover | 反馈延迟到 240ms 后文字才变化，已经接近“没响应”；曲线不是“匀加速”。300ms 离开回落是少数做对的退出。代理当前会缩放按钮本体。 | 总时长 260–360ms，文字延迟约 100–140ms，退出 200–240ms ease-in-out；修代理。 |
| `btn-trace` | 460ms，`.22,1,.36,1`，hover | 极前重曲线使线条头段闪现、尾段拖延；unhover 立即回到 scaleX(0)，没有退出。代理还会缩放按钮。 | 改 180–240ms ease；以 transition 实现可逆 scaleX，离开 140–190ms。 |
| `btn-glow` | 2.8s linear infinite | 旋转用 linear 正确，减弱模式保留静态边框也合理；但不能把“推荐操作”当作无限动画理由。暂停当前失效。 | 只绑定真实 running/attention 状态且全局仅一处；状态结束立刻卸载。 |
| `ico-bell` | 1.8s decay infinite | 衰减 keyframe本身像物理摆动，但“新消息”应事件触发一次，而不是永远摇。减弱后只剩静态铃铛，需由 badge/文字承载新消息语义。 | 600–900ms 单次播放；状态由 badge/可读文本表达。 |
| `ico-heart` | 1.4s ease-in-out infinite | 搏动在前 364ms 完成、后面停顿，节律可读；但收藏态常驻心跳会分散注意，且常驻 will-change。 | 仅状态切换时单次 450–650ms；收藏态用颜色/填充持久表达。 |
| `ico-flip` | 700ms，`.65,.05,.36,1`，hover | 对普通刷新反馈过长；鼠标中途离开会取消 animation 并可能跳回；stage 代理破坏 reduced motion。 | 改成真实刷新/切换成功后的 240–300ms 单次动画，键盘同样触发；修 reduced 代理。 |
| `ico-arrow` | 1.3s，`.65,0,.35,1` infinite | 使用对称 ease-in-out，并非 `.22,1,.36,1`，没有同类“前 150ms 冲完”问题；双箭头同 duration/ease，错峰有意。问题是无限常驻。 | 仅短期引导显示；完成/看过即停。减弱模式静态箭头方案可接受。 |
| `ld-orbit` | 1.1s/1.7s linear | 正常模式合理；3s 低速降级可有条件接受，但双圈在 reduced 下同速同向，信息增量为零。 | reduced 下保留一个 3s 单环或静态状态 + 文案；修暂停伪元素。 |
| `ld-comet` | 900ms linear | 正常 loading 语义合理，transform 旋转不触发布局；3s 降级有条件接受。 | 必须配真实 loading 文案/aria；reduced 下可用单个低速环。 |
| `ld-bars` | 900ms，decay，alternate | 负延迟让首帧完整是合理的；5 根永久 will-change 过度。静态 bars 在 reduced 下不足以单独说明“还在加载”。 | 移除 will-change；与 `role=status` 文案组合。 |
| `ld-track` | 1.2s ease-in-out | 位移起止都在裁剪区外，迭代跳点不可见；对不确定进度语义匹配。 | 可保留；reduced 的 70% 静态条必须搭配“处理中”文字，不能伪装成 70% 真进度。 |
| `ld-skeleton` | 1.4s 标准 ease | 用 transform 而非 background-position 是正确方向；但 shimmer 通常 linear 更自然，`--sk-hi` 暗色失控。暂停伪元素失效。 | 定义两主题 highlight；改 linear；reduced 静态骨架 + 可读 loading 语义。 |
| `tx-rise` | 1.8s，`.22,1,.36,1` infinite | 位移段使用极前重 ease-out，抬起和落回都像跳帧；循环文本也会长期抢注意。 | 改 ease-in-out，缩短活跃段；更推荐状态变化单次播放，常驻只保留文本。 |
| `st-dot` | 1.8s，`.22,1,.36,1` infinite | 扩散波使用 ease-out 有语义，两个环同 duration/ease；但暂停失效，长期运行时会持续吸睛。 | 仅真实 running 状态显示；降低 alpha/频率，reduced 静态圆环 + 状态文字。 |
| `tx-caret` | 1.06s steps(1) | 只动 opacity，约 0.94Hz，不触及 3 次/秒闪烁阈值；reduced 静态 caret 有语义。 | 可保留；确保仅在实际输入/生成状态出现。 |
| `tx-swap` | 420ms，`.22,1,.36,1`，hover | 当前不可落地：假成功、极前重、超过 300ms、无退出、无键盘等价；代理还会把动画施加给按钮。 | 改由真实复制状态驱动，180–220ms；入场 ease-out、成对位移 ease-in-out、退出更快，并用 live region 宣告。 |

### 总体性能判断

- **布局**：18 个 keyframes 没有动画化 width/height/margin/padding/top/left；主位移路径不会触发逐帧 layout，这一点合格。
- **paint/composite**：`filter: brightness()`、颜色/描边过渡、card border、渐变/mask 会产生 paint 或额外合成成本；数量不大，但与“只动 transform/opacity”的宣称不一致。
- **合成层**：长期 `will-change` 不克制。当前页面规模尚不至于直接卡顿，但把片段复制到列表/表格会放大显存和层管理成本。
- **入场**：卡片总尾长 840ms，明显偏慢；项目已有更合适的 180/220ms 预设。

---

## 7. 若要并入主项目：最小改造清单

### 原则

**不要把 18 个片段整包搬进产品。先绑定真实消费方，再只集成被批准的最小子集。** 主项目已经有 `Button` 的 `active:scale-[.98]`、`animate-spin`、`animate-pulse`、Skeleton/Progress、`src/lib/motion.ts` 与 orb 三套 keyframes，重复能力应删而不是叠加。

### 建议文件与顺序

1. **确定真实消费矩阵（先于编码）**
   - `btn-jelly/fill/trace/sheen`：默认不进入通用 Button；只有明确低频入口才新增语义 variant。
   - `ico-bell/heart/flip/arrow`：绑定通知到达、收藏成功、刷新成功、短时 onboarding 等具体状态；禁止默认 infinite。
   - loader：优先复用 `src/components/ui/skeleton.tsx`、`progress.tsx` 和 Button loading；最多补一个 indeterminate 形态。
   - `st-dot/tx-caret/tx-swap`：必须由真实 running/typing/copied 状态驱动。

2. **统一 keyframes、曲线与主题**
   - 修改 `tailwind.config.js`：只加入获批、命名空间清晰的 `theme.extend.keyframes` 和 `animation`，例如 `animate-status-ripple`、`animate-progress-indeterminate`；不要加入所有展示片段。
   - 修改 `src/lib/motion.ts`：补充通用 duration/easing 常量或 Motion variants；保持入场 160–260ms、stagger 约 35ms。不要在 CSS、TS、页面数据三处重复曲线。
   - 修改 `src/styles.css`：仅放 Tailwind 难表达的伪元素/compound selector 和局部 `prefers-reduced-motion`；颜色全部使用现有 HSL 语义 token。不要拷贝原型的 `:root/.dark`，不要使用全局 `*` 降级。
   - `--sk-hi` 如确实需要，优先用 `hsl(var(--foreground) / alpha)` 派生，不新增裸 hex token。

3. **复用现有组件接入真实页面**
   - `src/components/ui/button.tsx`：原则上不改；现有 `active:scale-[.98]` 已满足高频按钮的轻反馈。只有真实需求才加 variant。
   - `src/components/ui/skeleton.tsx`、`progress.tsx`：将获批 loader 作为现有组件 variant，而不是新增第二套 primitive。
   - 业务消费文件（例如 `src/modules/console/InstanceTable.tsx`）：状态动画只由真实 instance status 控制。
   - 图标一律通过 `src/components/icon.tsx`，不得内联复制 SVG。

4. **如果确实需要保留“动效工具箱”开发页**
   - 新增 `src/modules/dev/MotionKitPage.tsx`：页面组装，复用 Button/Input/Dialog/Tabs/Toaster 和 themeStore。
   - 新增 `src/modules/dev/motionCatalog.ts`：只保存 `id/name/description/trigger/className` 等类型化元数据，不保存可执行 CSS 大字符串。
   - 可选新增 `src/modules/dev/motion-snippets.css`：同一文件既正常 import 又 `?raw` 供复制，避免显示/复制漂移；hover 代理写显式 `:is()`。
   - 修改 `src/App.tsx`：只增加 `/_dev/motion-kit` 开发路由，不进生产导航；若产品没有真实“复制 CSS”需求，不要把它做成正式功能。

5. **测试与验收**
   - 增加纯逻辑测试：18/获批项的 id 唯一、root 与 markup 对应、hover 代理显式存在、复制状态只在 Promise 成功后出现。
   - 复用 `src/lib/color.ts` 增加两主题文字/按钮/状态色对比度测试；透明背景必须先合成。
   - 键盘验收：Tab 顺序、每个 hover 动效的 focus 等价路径、Dialog 焦点陷阱/恢复、Escape、toast 宣告。
   - reduced-motion 验收：每个获批动效的直接触发与代理触发都测；暂停后伪元素也必须停。
   - 执行 `npm run typecheck`、`npm test`、`npm run build:renderer` 和必要冒烟即可，不另造基础组件。

### 最小依赖变化

**无需新增第三方依赖。** React、Tailwind、`motion/react`、Radix、Vitest 和现有 UI/Toast/Theme 基础设施已经足够。引入新动画库只会增加两套时序模型。

---

## 8. 推荐的放行门槛

在以下条件同时满足前，维持“不放行”：

- [ ] 8 个 P0 全部关闭，尤其代理选择器、伪元素暂停、令牌格式冲突和 tx-swap 假成功。
- [ ] 浅/暗两套所有实际小字号文本 ≥ 4.5:1，交互边界/焦点指示可辨。
- [ ] 所有交互支持键盘并有统一 focus-visible；Dialog/Toast/状态控件语义完整。
- [ ] reduced-motion 覆盖直接触发、stage 代理、卡片入场和伪元素；两种 3s loader 有明确可读 loading 语义。
- [ ] 420–1800ms 的极前重位移动画已重做；unhover 不再硬跳。
- [ ] 并入代码只使用主项目 HSL 语义令牌、`data-theme`、现有 UI 组件和 `Icon`。
- [ ] 只集成有真实消费方的动效；未使用片段继续留在设计原型，不进入生产 bundle。
