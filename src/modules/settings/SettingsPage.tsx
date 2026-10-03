import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Kbd } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Icon } from '@/components/icon'
import { PageHeader } from '@/components/blocks/page-header'
import { hasElectron, ipc } from '@/lib/ipc'
import { THEME_LABEL, THEME_MODES } from '@/lib/theme'
import type { ThemeMode } from '@/lib/theme'
import { HOTKEY_ACTIONS, HOTKEY_ACTION_LABEL, HOTKEY_SCOPE_LABEL, formatAccel, hotkeyMapOf } from '@/lib/hotkey'
import { useThemeStore } from '@/stores/themeStore'
import { useInstanceStore } from '@/stores/instanceStore'
import { engineStatusOf, useInstances } from '@/modules/console/useInstances'
import { useHotkeySync } from '@/modules/console/useHotkeySync'
import { fadeItem, staggerList } from '@/lib/motion'

const ENGINE_PORT = 8731
const APP_VERSION = '0.1.0'

const THEME_DESC: Record<ThemeMode, string> = {
  light: '始终使用浅色界面',
  dark: '始终使用深色界面，适合长时间盯屏',
  system: '跟随 Windows 的浅色 / 深色设置自动切换',
}

/** 设置：全局偏好的唯一去处。实例级配置（含热键）在各自实例窗口里改，两者不混。 */
export default function SettingsPage() {
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)
  const [dataDir, setDataDir] = useState('')
  const qc = useQueryClient()
  const instances = useInstanceStore((s) => s.instances)
  const { isPending, isError, isSuccess } = useInstances()
  const engine = engineStatusOf({ isPending, isError, isSuccess })
  const { conflicts, failed } = useHotkeySync()

  useEffect(() => {
    ipc.userData().then(setDataDir)
  }, [])

  const engineTag = engine === 'ok' ? 'success' : engine === 'down' ? 'destructive' : 'secondary'

  const list = Object.values(instances).sort((a, b) => a.name.localeCompare(b.name))
  const conflictByAccel = new Map(conflicts.map((c) => [`${c.action}:${c.accel}`, c]))

  return (
    <div className="mx-auto max-w-[1240px] space-y-4 p-5">
      <PageHeader icon="settings" title="设置" desc="外观、快捷键、引擎与数据的全局偏好；修改即时生效" />

      <motion.div variants={staggerList} initial="hidden" animate="show" className="grid grid-cols-12 gap-4">
        <div className="col-span-12 space-y-4 lg:col-span-8">
          {/* ── 外观 ── */}
          <motion.div variants={fadeItem}>
            <Card>
              <CardHeader>
                <CardTitle>外观</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {THEME_MODES.map((m) => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={`rounded-lg border p-3 text-left transition-colors ${
                        mode === m
                          ? 'border-primary bg-primary/[0.06] ring-2 ring-primary/15'
                          : 'border-border hover:border-muted-foreground/30 hover:bg-accent/40'
                      }`}
                    >
                      <ThemePreview mode={m} />
                      <div className="mt-2.5 flex items-center gap-2">
                        <span className="text-[13px] font-medium">{THEME_LABEL[m]}</span>
                        {mode === m && <Badge variant="default">当前</Badge>}
                      </div>
                      <div className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{THEME_DESC[m]}</div>
                    </button>
                  ))}
                </div>
                <p className="text-[12px] leading-relaxed text-muted-foreground">
                  主题同时作用于控制台与所有实例窗口，选择会记住，下次打开保持一致。
                </p>
              </CardContent>
            </Card>
          </motion.div>

          {/* ── 快捷键 ── */}
          <motion.div variants={fadeItem}>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Icon name="keyboard" size={14} className="text-muted-foreground" />
                  快捷键
                </CardTitle>
                <span className="text-[12px] text-muted-foreground">{list.length} 个实例</span>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* 这是用户最关心的一件事，直接在页面上把规则写清楚 */}
                <Alert variant="info">
                  <Icon name="info" size={16} />
                  <AlertDescription className="space-y-1.5">
                    <p>
                      <b className="font-medium">三个动作（开始 / 暂停 / 停止）的键都是按实例配置的，不会互相牵连。</b>
                      两个实例都绑 <Kbd>F9</Kbd> 时，按下只会作用于一个（优先当前焦点所在的实例窗口），
                      不会两个一起动。
                    </p>
                    <p>
                      这些键在系统级注册，所以自动化跑起来、焦点落在目标程序上时依然能按到；
                      代价是它会占用这个键位，目标程序的同名按键收不到。
                    </p>
                  </AlertDescription>
                </Alert>

                {(conflicts.length > 0 || failed.length > 0) && (
                  <div className="space-y-2">
                    {conflicts.map((c) => (
                      <Alert key={`${c.action}:${c.accel}`} variant="warning">
                        <Icon name="warning" size={16} />
                        <AlertDescription>
                          <b className="font-medium">{formatAccel(c.accel)}</b>（{HOTKEY_ACTION_LABEL[c.action]}）被{' '}
                          {c.owners.length} 个实例同时占用：{c.owners.map((o) => o.name).join('、')}。
                          按下时会作用于其中一个，其余不受影响；想各自独立就改掉重复的键。
                        </AlertDescription>
                      </Alert>
                    ))}
                    {failed.length > 0 && (
                      <Alert variant="destructive">
                        <Icon name="error" size={16} />
                        <AlertDescription>
                          这些键没能注册成功（多半被别的程序占用了）：{failed.map(formatAccel).join('、')}。请改成别的键。
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                )}

                <div className="overflow-hidden rounded-lg border border-border">
                  <Table className="min-w-[680px]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>实例</TableHead>
                        {/* 按动作清单生成列，不手写 —— 多加一个动作时这张表会自动跟上 */}
                        {HOTKEY_ACTIONS.map((action) => (
                          <TableHead key={action} className="w-[120px]">
                            {HOTKEY_ACTION_LABEL[action]}
                          </TableHead>
                        ))}
                        <TableHead className="w-[130px]">作用范围</TableHead>
                        <TableHead className="w-[96px] text-right" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {list.map((i) => {
                        const hk = hotkeyMapOf(i.config)
                        return (
                          <TableRow key={i.id}>
                            <TableCell>
                              <div className="font-medium">{i.name}</div>
                              <div className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">{i.id}</div>
                            </TableCell>
                            {HOTKEY_ACTIONS.map((action) => (
                              <KeyCell
                                key={action}
                                accel={hk[action]}
                                conflict={!!conflictByAccel.get(`${action}:${hk[action]}`)}
                                failed={failed.includes(hk[action])}
                              />
                            ))}
                            <TableCell className="text-[12.5px] text-muted-foreground">{HOTKEY_SCOPE_LABEL[hk.scope]}</TableCell>
                            <TableCell className="text-right">
                              <Button variant="ghost" size="sm" asChild>
                                <Link to={`/instances`} title="热键在实例窗口的「配置」里修改">
                                  去修改
                                </Link>
                              </Button>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                      {!list.length && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={2 + HOTKEY_ACTIONS.length} className="py-8 text-center text-[12.5px] text-muted-foreground">
                            还没有实例；新建实例后这里会列出它的快捷键。
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>

                <Separator />

                <div className="space-y-2">
                  <div className="text-[12.5px] font-medium text-muted-foreground">窗口内快捷键（不占用系统按键）</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[
                      { keys: ['Ctrl', 'S'], desc: '在实例配置页保存当前配置' },
                      { keys: ['/'], desc: '聚焦控制台左侧导航的搜索框' },
                      { keys: ['Esc'], desc: '清空搜索 / 关闭弹出的对话框' },
                    ].map((r) => (
                      <div key={r.desc} className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
                        <span className="flex flex-none items-center gap-1">
                          {r.keys.map((k) => (
                            <Kbd key={k}>{k}</Kbd>
                          ))}
                        </span>
                        <span className="text-[12.5px] text-muted-foreground">{r.desc}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        <div className="col-span-12 space-y-4 lg:col-span-4">
          <motion.div variants={fadeItem}>
            <Card>
              <CardHeader>
                <CardTitle>引擎</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2">
                  <Badge variant={engineTag}>
                    {engine === 'ok' ? '已连接' : engine === 'down' ? '未连接' : '检测中'}
                  </Badge>
                  <span className="font-mono text-[12.5px] text-muted-foreground">127.0.0.1:{ENGINE_PORT}</span>
                  <div className="flex-1" />
                  <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ['instances'] })}>
                    <Icon name="refresh" size={13} />
                    重新检测
                  </Button>
                </div>
                <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                  引擎是随应用一起启动的本地服务，负责执行实例、读写 Excel 与素材库。应用退出时它一起关闭，不需要单独安装 Python。
                </p>
                {engine === 'down' && (
                  <Alert variant="destructive">
                    <Icon name="error" size={16} />
                    <AlertDescription>连不上引擎：请确认 8731 端口没有被其它程序占用，然后重启应用。</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>
          </motion.div>

          <motion.div variants={fadeItem}>
            <Card>
              <CardHeader>
                <CardTitle>数据</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <div className="text-[12.5px] font-medium text-muted-foreground">数据目录</div>
                  <div className="break-all rounded-lg border border-border bg-muted/50 px-3 py-2 font-mono text-[11.5px]">
                    {dataDir || '（浏览器预览下不可用）'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled={!hasElectron || !dataDir} onClick={() => void ipc.openPath(dataDir)}>
                    <Icon name="folder" size={13} />
                    打开目录
                  </Button>
                  <Button variant="outline" size="sm" disabled={!hasElectron || !dataDir} onClick={() => void ipc.showItem(dataDir)}>
                    <Icon name="maximize" size={13} />
                    定位
                  </Button>
                </div>
                <p className="text-[12px] leading-relaxed text-muted-foreground">
                  实例配置、运行记录与图像素材都存在这里，备份时整个目录拷走即可。
                </p>
              </CardContent>
            </Card>
          </motion.div>

          <motion.div variants={fadeItem}>
            <Card>
              <CardHeader>
                <CardTitle>关于</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-[13px]">
                {[
                  ['产品', 'AutoPlay Studio'],
                  ['版本', APP_VERSION],
                  ['架构', '控制台 + 独立实例多开'],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{k}</span>
                    <span className={k === '版本' ? 'font-mono' : undefined}>{v}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </motion.div>
    </div>
  )
}

function KeyCell({ accel, conflict, failed }: { accel: string; conflict: boolean; failed: boolean }) {
  const bad = conflict || failed
  return (
    <TableCell>
      <span className="flex items-center gap-1.5">
        <Kbd className={bad ? 'border-[hsl(var(--warn)/0.5)] text-[hsl(var(--warn))]' : undefined}>{formatAccel(accel)}</Kbd>
        <AnimatePresence>
          {bad && (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center">
                    <Icon
                      name={failed ? 'error' : 'warning'}
                      size={13}
                      className={failed ? 'text-destructive' : 'text-[hsl(var(--warn))]'}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{failed ? '注册失败：按键被其它程序占用' : '与其它实例重复；按下只作用于其中一个'}</TooltipContent>
              </Tooltip>
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </TableCell>
  )
}

/** 主题预览缩略图：一眼看出选中项长什么样，而不是只读文字 */
function ThemePreview({ mode }: { mode: ThemeMode }) {
  if (mode === 'system') {
    return (
      <div className="flex h-[52px] overflow-hidden rounded-md border border-border">
        <PreviewPane dark={false} className="flex-1" />
        <PreviewPane dark className="flex-1 border-l border-border" />
      </div>
    )
  }
  return (
    <div className="h-[52px] overflow-hidden rounded-md border border-border">
      <PreviewPane dark={mode === 'dark'} />
    </div>
  )
}

function PreviewPane({ dark, className = '' }: { dark: boolean; className?: string }) {
  // 预览用固定色值而非令牌：它要同时展示两种主题，不能跟着当前主题走
  return (
    <div className={`flex h-full ${className}`} style={{ background: dark ? '#1A1A1E' : '#F7F8FA' }}>
      <div className="h-full w-[26%]" style={{ background: dark ? '#232327' : '#FFFFFF' }} />
      <div className="flex-1 space-y-1 p-1.5">
        <div className="h-2 rounded-sm" style={{ background: dark ? '#33333B' : '#E5E6EB' }} />
        <div className="h-2 w-2/3 rounded-sm" style={{ background: dark ? '#33333B' : '#E5E6EB' }} />
        <div className="h-2 w-1/2 rounded-sm" style={{ background: '#165DFF', opacity: dark ? 0.85 : 1 }} />
      </div>
    </div>
  )
}
