import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import fs from 'node:fs'

// 渲染进程与本仓库的 Python 引擎（:8731）分别独立运行，
// 开发期通过代理访问，打包后由主进程拉起 sidecar。

// vitest 的依赖缓存默认落在系统临时目录，部分环境会拦截那里的写入（EPERM），
// 改到工程目录内（且不在 node_modules 下，否则沙箱会拦写入），测试才跑得稳。
const tmpDir = path.resolve(__dirname, '.vitest-tmp')
process.env.TMP = process.env.TEMP = tmpDir
fs.mkdirSync(tmpDir, { recursive: true })
export default defineConfig({
  // 打包后由 Electron 以 file:// 加载 index.html，必须用相对路径，否则 /assets/* 会被解析到磁盘根
  base: './',
  plugins: [react()],
  cacheDir: 'node_modules/.vite',
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8731',
      '/ws': { target: 'ws://127.0.0.1:8731', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    // 默认 pool 是 'web'，其 worker 会把 fetch 缓存写进 <TMP>/web，本地沙箱拦截该写入（EPERM）
    // 导致 api.test.ts 等文件收集被中断；改用 threads 池（纯 Node worker）绕开该缓存目录。
    pool: 'threads',
    // electron/ 是主进程代码，但其中「纯逻辑 + 注入点」的部分（如通知泵）同样要测：
    // 设备层（真弹窗、角标）只人工验收，可测部分靠注入假实现。
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'electron/**/*.test.ts'],
  },
})
