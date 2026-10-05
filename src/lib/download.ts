/**
 * 触发浏览器把一段文本存成文件。
 *
 * 纯 DOM 适配层（Blob + a[download]），没有可测的行为 —— 逻辑都在各处的
 * CSV 纯函数里（`lib/csv`、`lib/logiCopy`、`lib/summaryCsv`），这里只负责落盘。
 */
export function downloadTextFile(fileName: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  // 立刻回收：blob 一直挂着会占内存，而下载已经开始了
  URL.revokeObjectURL(url)
}
