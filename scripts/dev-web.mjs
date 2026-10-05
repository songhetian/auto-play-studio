/**
 * 一键起「浏览器预览」环境：Python 引擎(8731) + 渲染层(5173)。
 *
 * 为什么不用 `npm run dev` 就完事：渲染层起来后，界面会因为拿不到引擎数据而显示
 * 「引擎未连接」，各处列表是空的，看起来像坏了。同时手动开两个终端也麻烦。
 *
 * 行为：
 *  - 端口已被别的进程占用时**直接复用**（不重复起，避免 EADDRINUSE 报错刷屏）
 *  - Ctrl+C 时只关掉本脚本自己起的进程，不误杀你已有的服务
 *
 * 用法：npm run dev:web   然后浏览器打开 http://127.0.0.1:5173
 */
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'

const ENGINE_PORT = 8731
const WEB_PORT = 5173

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function probe(port) {
  return new Promise((res) => {
    // 同时探 127.0.0.1 与 ::1：vite 默认可能只绑 ::1
    const tryHost = (host) =>
      new Promise((r) => {
        const s = net.createConnection({ port, host })
        s.on('connect', () => { s.destroy(); r(true) })
        s.on('error', () => r(false))
        s.setTimeout(700, () => { s.destroy(); r(false) })
      })
    Promise.all([tryHost('127.0.0.1'), tryHost('::1')]).then((r) => res(r[0] || r[1]))
  })
}

/** 找一个可用的 python：优先项目约定的 FlyEnv Python（已装好引擎依赖） */
function pickPython() {
  const candidates = [
    process.env.AUTOPLAY_PYTHON,
    'D:/Program Files/FlyEnv-Data/env/python/python.exe',
    'python',
  ].filter(Boolean)
  for (const c of candidates) {
    if (c === 'python') {
      const r = spawnSync('python', ['-c', 'import fastapi,uvicorn'], { stdio: 'ignore' })
      if (r.status === 0) return c
      continue
    }
    const r = spawnSync(c, ['-c', 'import fastapi,uvicorn'], { stdio: 'ignore' })
    if (r.status === 0) return c
  }
  return null
}

const children = []
function start(label, cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: false, ...opts })
  p.on('error', (e) => console.error(`[${label}] 启动失败：${e.message}`))
  children.push(p)
  return p
}

async function main() {
  console.log('启动浏览器预览环境…\n')

  // ── 引擎 ──
  if (await probe(ENGINE_PORT)) {
    console.log(`✓ 引擎已在 ${ENGINE_PORT} 运行，直接复用`)
  } else {
    const py = pickPython()
    if (!py) {
      console.error('✗ 找不到带 fastapi/uvicorn 的 Python。')
      console.error('  可用 AUTOPLAY_PYTHON 环境变量指定，或先 pip install -r python/requirements.txt')
      process.exit(1)
    }
    console.log(`· 用 ${py} 启动引擎…`)
    start('engine', py, ['-m', 'uvicorn', 'engine.main:app', '--app-dir', 'python', '--port', String(ENGINE_PORT)])
    for (let i = 0; i < 40; i++) {
      await wait(250)
      if (await probe(ENGINE_PORT)) { console.log(`✓ 引擎就绪 ${ENGINE_PORT}`); break }
    }
  }

  // ── 渲染层 ──
  console.log('')
  if (await probe(WEB_PORT)) {
    console.log(`✓ 渲染层已在 ${WEB_PORT} 运行，直接复用`)
    console.log(`\n打开浏览器访问：http://127.0.0.1:${WEB_PORT}/`)
    console.log('（改完代码 vite 会热更新，刷新页面即可，不用重启）')
    console.log('想看真实效果截图：npm run preview')
    return
  }
  console.log('· 启动 vite 渲染层…')
  // 必须显式 --host 127.0.0.1：vite 默认只绑 localhost(::1)，探测与截图都走 IPv4
  const viteBin = new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  start('vite', process.execPath, [viteBin, '--port', String(WEB_PORT), '--host', '127.0.0.1'])

  for (let i = 0; i < 60; i++) {
    await wait(250)
    if (await probe(WEB_PORT)) {
      console.log(`\n✓ 渲染层就绪`)
      console.log(`打开浏览器访问：http://127.0.0.1:${WEB_PORT}/`)
      console.log('（改完代码 vite 会热更新，刷新页面即可，不用重启）')
      console.log('想看真实效果截图：npm run preview')
      console.log('按 Ctrl+C 结束')
      return
    }
  }
  console.error('✗ 渲染层没能在预期时间内起来')
}

function shutdown() {
  for (const p of children) {
    try { p.kill() } catch { /* 已退出 */ }
  }
  console.log('\n已停止本次启动的进程。')
}
process.on('SIGINT', () => { shutdown(); process.exit(0) })
process.on('SIGTERM', () => { shutdown(); process.exit(0) })

main().catch((e) => { console.error(e); process.exit(1) })
