import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { api } from '@/lib/api'
import { pendingCsv, pendingFileName } from '@/lib/summaryCsv'
import { downloadTextFile } from '@/lib/download'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Icon } from '@/components/icon'
import { toast } from '@/stores/toastStore'
import { fadeUp } from '@/lib/motion'

/**
 * 本轮结论：一句话 + 失败原因归类 + 待人工确认清单。
 *
 * 数字上面的指标卡已经在说了，这里只回答**接下来要做什么**：
 * 这一轮到底算不算跑通、坏在什么地方、哪几行得人去补。
 *
 * 结论与归类都是引擎算的（`engine/summary.py`）。前端不再算一遍 ——
 * 同一个数字两处各算一次，迟早会出现「页面说 3 条失败、导出说 4 条」。
 */
export default function RunSummaryCard({ id, name, running }: { id: string; name: string; running: boolean }) {
  const { data } = useQuery({
    queryKey: ['summary', id],
    queryFn: () => api.runSummary(id),
    // 指标卡已经每秒在动了；这里要过一遍全部行，而且结论不需要秒级跟随
    refetchInterval: running ? 3000 : false,
  })

  if (!data) return null

  const exportCsv = () => {
    downloadTextFile(pendingFileName(name), pendingCsv(data.pending))
    toast.success(`已导出 ${data.pending.length} 行待人工确认清单`)
  }

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            本轮结论
            {data.pending.length > 0 && <Badge variant="warning">{data.pending.length} 行要人工补</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-base">{data.headline}</div>

          {data.reasons.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-sm text-muted-foreground">失败原因（按出现次数）</div>
              {data.reasons.map((r, i) => (
                <div key={`${r.label}-${i}`} className="flex items-start gap-2.5 rounded-lg border border-border p-2.5">
                  <Badge variant="destructive" className="mt-0.5 shrink-0">
                    {r.count} 行
                  </Badge>
                  <div className="min-w-0">
                    <div className="text-base leading-relaxed">{r.label}</div>
                    <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                      第 {r.rows.slice(0, 8).join('、')}
                      {r.rows.length > 8 ? ` 等 ${r.rows.length} 行` : ' 行'}
                    </div>
                  </div>
                </div>
              ))}
              {data.otherReasons > 0 && (
                <div className="text-sm text-muted-foreground">另有 {data.otherReasons} 类各只出现了一次，不单独列</div>
              )}
            </div>
          )}

          {data.pending.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button variant="outline" size="sm" onClick={exportCsv}>
                <Icon name="download" size={14} />
                导出待人工确认清单
              </Button>
              <span className="text-sm text-muted-foreground">
                一行一条：行号、主键、失败原因。照着行号回原表里补
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}
