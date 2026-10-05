# PRD · 定时提醒（功能 2）

## 目标
防止遗漏重要事项。用户设置「提醒内容 + 触发时间」，到期时在应用内弹**居中拦截式弹窗**（必须点掉，而非一闪而过的 toast）。

## 范围（v1）
- **应用运行期间**有效：全局定时器每 30s 扫描到期项并弹窗。
- 不做 OS 级通知 / 计划任务（关机不触发）。若后续要"关机也提醒"，列为独立增强（接系统通知）。
- 单用户、本地数据，不跨端同步。

## 数据模型
```
Reminder {
  id: string          // uuid
  content: string     // 提醒内容（必填，≤200 字）
  at: string          // 触发时间 ISO8601（必填，须晚于现在）
  done: boolean       // 是否已处理
  snoozedUntil?: string // 「稍后」后的下次弹窗时间
  createdAt: string
}
```
存储：`zustand persist` → `localStorage('autoplay.reminders')`。

## 用户流程
1. 入口：顶部栏「提醒」铃铛（带"即将到期"角标）；点击展开提醒面板。
2. 新增：面板内「+ 新建提醒」→ 表单（内容 textarea + 时间 `datetime-local` + 保存）。
3. 列表：分「待提醒 / 已完成」两组；每条可编辑时间、删除。
4. 到期：全局 `setInterval` 命中 `at ≤ now 且 !done 且 (无 snooze 或 snoozedUntil ≤ now)` → 弹**居中 Modal**：显示内容 + 「完成」/「稍后 5 分钟」。
5. 启动兜底：应用启动时立即扫一次——若 `at` 已过期且未 `done`，启动即弹（避免沉睡期间完全漏掉）。

## 弹窗视觉规范（用户优化：原样式太简单，需升级）
到期弹窗做成**产品级通知卡**，而非朴素白卡：
- **渐变头 + 分类色条**：头部 `bg-gradient-to-r from-indigo-500 to-violet-500`，左侧图标环（白底半透明环），按 `category` 着色（工作/物流/客服/个人）。
- **虚化遮罩**：遮罩层 `bg-slate-900/30 backdrop-blur-sm`，聚焦弹窗、弱化底层。
- **内容卡片化**：标题行（分类 + 小标题）+ 大号内容块 + "设定时间 / 已到期"信息条。
- **主次按钮**：「完成」实心品牌色带柔和投影；「稍后」描边次要。
- **入场动画**：轻微 scale + fade（不刺眼），与现有 Dialog 动效一致。

## 数据模型（补充 category 字段）
```
Reminder {
  id, content, at, done, snoozedUntil?, createdAt,
  category: 'work' | 'logistics' | 'service' | 'personal'  // 决定弹窗色条/图标
}
```

## 验收标准
- [ ] 可新增 / 编辑 / 删除提醒；时间校验（不能选过去）；可选分类。
- [ ] 到期弹**居中拦截 Modal**（非 toast），视觉符合上方规范（渐变头 + 图标环 + 虚化遮罩 + 主次按钮）。
- [ ] 「完成」标记 done 不再弹，「稍后」5 分钟后重弹。
- [ ] 全局定时器 30s 一轮，不卡 UI（放 AppShell 顶层 hook）。
- [ ] 持久化：重开应用仍记得未完成的提醒；启动兜底弹过期项。
- [ ] 铃铛角标显示未来 5 分钟内将到期的条数。

## 技术落点（实现阶段）
- `src/stores/reminderStore.ts`（persist）
- `src/hooks/useReminderScheduler.ts`（`setInterval` 扫 + 维护"当前到期项"状态）
- `src/components/reminder/ReminderBell.tsx`（入口+面板）、`ReminderModal.tsx`（到期弹窗）
- 复用现有 `Dialog` / `Button` / `Input`；时间选择用 `<input type="datetime-local">` 包一层 `Input` 外观。
- TDD：先写 `reminderStore` 行为测试（增删/到期判定纯函数 `isDue(r, now)`）+ scheduler 判定，再接 UI。
