import { contextBridge, ipcRenderer } from 'electron'

export interface Region {
  x: number
  y: number
  width: number
  height: number
}

/** 遮罩窗口专用的极窄桥：只负责把框选结果或「取消」送回主进程 */
contextBridge.exposeInMainWorld('region', {
  done: (rect: Region | null) => ipcRenderer.send('region:result', rect),
})
