import { HashRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import AppShell from '@/app/AppShell'
import { useThemeEffect } from '@/stores/themeStore'
import DashboardPage from '@/modules/console/DashboardPage'
import InstancesPage from '@/modules/console/InstancesPage'
import ToolLandingPage from '@/modules/tools/ToolLandingPage'
import AssetLibraryPage from '@/modules/assets/AssetLibraryPage'
import KbPage from '@/modules/kb/KbPage'
import ExcelPrepPage from '@/modules/excel/ExcelPrepPage'
import ExcelToolboxPage from '@/modules/excel/ExcelToolboxPage'
import SettingsPage from '@/modules/settings/SettingsPage'
import HitEventsPage from '@/modules/alerts/HitEventsPage'
import ViolationStatsPage from '@/modules/alerts/ViolationStatsPage'
import PhrasePage from '@/modules/phrases/PhrasePage'
import RemindersPage from '@/modules/reminders/RemindersPage'
import FlowGuidePage from '@/modules/flow/FlowGuidePage'
import SensitiveWordsPage from '@/modules/sensitive/SensitiveWordsPage'
import OrbWindow from '@/modules/attendant/OrbWindow'
import PhraseQuickPanel from '@/modules/attendant/PhraseQuickPanel'
import DialogShowcase from '@/modules/dev/DialogShowcase'
import ConfigPage from '@/modules/instance/ConfigPage'
import RunPage from '@/modules/instance/RunPage'
import { useInstances } from '@/modules/console/useInstances'

const ENGINE_PORT = 8731

/**
 * 两种外壳：
 *  - ConsoleShell：控制台窗口，带左侧导航（AppShell）
 *  - InstanceShell：每个实例一个独立窗口，只放内容本身，不套导航
 *
 * 实例是多开架构，套上控制台导航反而让人以为能在这个窗口里切别的实例。
 */
function InstanceShell() {
  // 实例列表要在这个窗口里自己拉一次：`useInstances` 是实例状态的唯一数据入口，
  // 而实例窗口是**独立的渲染进程**，读不到控制台那一份 react-query 缓存。
  //
  // 少了这一句的后果很具体：点「开始执行」之后状态徽标、进度、执行明细永远停在
  // 点下去那一刻 —— 引擎那边其实跑完了，窗口里还写着「启动中」。
  useInstances()

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <Outlet />
      </div>
      <div className="flex-none h-7 flex items-center px-4 gap-4 text-sm bg-surf border-t border-gray-3 text-gray-6">
        <span>实例窗口 · 独立运行</span>
        <span className="font-mono">引擎 127.0.0.1:{ENGINE_PORT}</span>
        <div className="flex-1" />
        <span>F9 暂停 · F10 停止（作用于本窗口）</span>
      </div>
    </div>
  )
}

export default function App() {
  // 两个窗口都同步主题，保证实例窗口不会与控制台配色不一致
  useThemeEffect()

  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/instances" element={<InstancesPage />} />
          <Route path="/tools/:toolId" element={<ToolLandingPage />} />
          <Route path="/assets" element={<AssetLibraryPage />} />
          <Route path="/kb" element={<KbPage />} />
          <Route path="/excel" element={<ExcelPrepPage />} />
          <Route path="/excel-toolbox" element={<ExcelToolboxPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/hits" element={<HitEventsPage />} />
          <Route path="/violations" element={<ViolationStatsPage />} />
          <Route path="/phrases" element={<PhrasePage />} />
          <Route path="/reminders" element={<RemindersPage />} />
          <Route path="/flow-guide" element={<FlowGuidePage />} />
          <Route path="/sensitive-words" element={<SensitiveWordsPage />} />
          {/* 弹窗展厅：只给开发预览用，不进导航 */}
          <Route path="/_dev/dialogs" element={<DialogShowcase />} />
        </Route>

        <Route element={<InstanceShell />}>
          <Route path="/instance/:id/config" element={<ConfigPage />} />
          <Route path="/instance/:id/run" element={<RunPage />} />
        </Route>

        {/* 悬浮球：置顶透明小窗加载这一页，不套任何外壳（要全透明、无导航） */}
        <Route path="/orb" element={<OrbWindow />} />

        {/* 话术速查面板：热键唤起的小窗，同样不套外壳 */}
        <Route path="/phrases-quick" element={<PhraseQuickPanel />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  )
}
