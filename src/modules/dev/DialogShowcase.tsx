import { useState } from 'react'
import { RHYTHM } from '@/components/blocks/rhythm'
import { PageHeader } from '@/components/blocks/page-header'
import { ConfirmDialog } from '@/components/blocks/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/blocks/field'
import { Icon } from '@/components/icon'

/**
 * 弹窗展厅（仅开发预览用）。
 *
 * 存在的理由：弹窗样式**必须并排看**才能判断分型是否有效 —— 单看一个红色弹窗
 * 感觉"挺醒目"，但把它和警告/信息放一起才发现原来的都一个样。
 * 改动弹窗体系后打开这个页面一次，比开五次真实流程快得多。
 */
type Kind = 'danger' | 'warn' | 'info' | 'form'

const CASES: Array<{
  kind: Kind
  label: string
  desc: string
  action?: string
  tone?: 'danger' | 'warn' | 'info' | 'form'
  icon?: 'trash' | 'warning' | 'play' | 'info'
  title: string
  body: string
  confirm: string
}> = [
  {
    kind: 'danger',
    label: '危险 · 删除实例',
    desc: '红色强调带 + 危险操作徽标 + 拦回车（防手滑删掉）',
    action: 'delete',
    icon: 'trash',
    title: '删除实例「千牛-自动回复」？',
    body: '实例的配置与运行记录会一起删除，该操作不可撤销。',
    confirm: '删除',
  },
  {
    kind: 'warn',
    label: '警告 · 素材被占用',
    desc: '琥珀强调带 + 注意徽标；不是删除，是"你暂时不能删"',
    tone: 'warn',
    icon: 'warning',
    title: '这张图正在被使用',
    body: '「千牛-自动回复」里的第 3 条指令正在用它。强制删除后那一步会执行失败。',
    confirm: '仍然删除',
  },
  {
    kind: 'info',
    label: '信息 · 开始执行',
    desc: '品牌色点缀，中性不吓人；回车可直接确认',
    action: 'start',
    icon: 'play',
    title: '开始执行？',
    body: '会真实操作「千牛」窗口并逐行发送，共 42 行。发送间隔 500ms。',
    confirm: '开始',
  },
  {
    kind: 'form',
    label: '表单 · 输入类',
    desc: '同品牌色，但中间有输入区，footer 独立成条',
    title: '重命名实例',
    body: '起个自己看得懂的名字，实例一多就只能靠名字认了。',
    confirm: '保存',
  },
]

export default function DialogShowcase() {
  const [open, setOpen] = useState<Kind | null>(null)
  const [name, setName] = useState('')

  return (
    <div className={RHYTHM.pageShell}>
      <PageHeader
        icon="boxes"
        title="弹窗展厅"
        desc="同一套结构、四种语气。改动弹窗体系后打开这里并排看，比走一遍真实流程快得多"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {CASES.map((c) => (
          <Card key={c.kind} className="transition-colors hover:border-border/80">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span
                  className={
                    c.kind === 'danger'
                      ? 'flex size-6 items-center justify-center rounded-md bg-destructive/10 text-destructive'
                      : c.kind === 'warn'
                        ? 'flex size-6 items-center justify-center rounded-md bg-warn/14 text-warn'
                        : 'flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary'
                  }
                >
                  <Icon name={c.icon ?? 'info'} size={13} />
                </span>
                {c.label}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-3 p-4">
              <span className="text-sm leading-relaxed text-muted-foreground">{c.desc}</span>
              <Button size="sm" onClick={() => setOpen(c.kind)}>
                打开
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {CASES.map((c) => (
        <ConfirmDialog
          key={c.kind}
          open={open === c.kind}
          onOpenChange={(v) => !v && setOpen(null)}
          title={c.title}
          desc={c.body}
          confirmText={c.confirm}
          action={c.action}
          tone={c.tone ?? (c.kind === 'warn' ? 'warn' : c.kind === 'form' ? 'form' : undefined)}
          icon={c.icon}
          onConfirm={() => setOpen(null)}
        >
          {c.kind === 'form' && (
            <Field label="实例新名字" required>
              <Input autoFocus value={name} placeholder="例如 千牛-华东组" onChange={(e) => setName(e.target.value)} />
            </Field>
          )}
        </ConfirmDialog>
      ))}
    </div>
  )
}
