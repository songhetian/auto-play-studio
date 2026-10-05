/**
 * 页面截图工具（开发期看效果用，不必每次打包 exe）。
 *
 * 为什么需要它：`chrome --headless --screenshot` 会在 SPA 渲染完成前就拍，
 * 拍出来是一张白屏。这个脚本用 CDP 轮询 `document.getElementById('root').innerHTML.length`，
 * 等界面真的有内容了再截。
 *
 * 用法：
 *   node scripts/screenshot.mjs                      # 截默认的几个页面
 *   node scripts/screenshot.mjs "#/=>out/a.png" ...  # 自定义 路由=>输出 列表
 *
 * 前置：先起 `npm run dev`（渲染层 5173）。
 * 依赖：需要能连上 Chrome 的 CDP 端口，用系统自带 Chrome，不依赖 puppeteer。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'

const CHROME =
  process.env.CHROME_PATH ||
  ['C:/Program Files/Google/Chrome/Application/chrome.exe',
   'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
   '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p))

const BASE = process.env.PREVIEW_BASE || 'http://127.0.0.1:5173'
const VIEWPORT = { width: 1440, height: 900, scale: 2 }

// 路由 => 文件名；默认覆盖「侧边栏工具名」最需要验收的几个页面
const DEFAULT_PAGES = [
  ['#/', '01-dashboard.png'],
  ['#/instances', '02-instances.png'],
  ['#/settings', '03-settings.png'],
]

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(port, urlPath) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => {
        try { res(JSON.parse(d)) } catch (e) { rej(e) }
      })
    })
    req.on('error', rej)
  })
}

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}

/** 极简 CDP 客户端：只实现发命令 + 等响应 + 订阅事件，避免引入 puppeteer 依赖 */
async function connect(wsUrl) {
  // Node 22 自带全局 WebSocket，无需依赖
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  let id = 0
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    else if (m.method) events.push(m)
  })
  return {
    send: (method, params = {}) =>
      new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })) }),
    events,
    close: () => ws.close(),
  }
}

async function main() {
  if (!CHROME) {
    console.error('找不到 Chrome，可用 CHROME_PATH 环境变量指定路径')
    process.exit(1)
  }
  // 确认渲染层在跑
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(3000) })
  } catch {
    console.error(`渲染层没起来（${BASE} 无响应）。先执行：npm run dev`)
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const pages = args.length
    ? args.map((a) => a.split('=>'))
    : DEFAULT_PAGES.map(([r, f]) => [r, path.join('designs/preview', f)])

  const port = await freePort()
  const profile = path.join(os.tmpdir(), `autoplay-shot-${Date.now()}`)
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader', '--hide-scrollbars',
    '--force-color-profile=srgb', '--disable-lcd-text',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' })

  const cleanup = () => {
    try { proc.kill() } catch { /* 已退出 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }

  try {
    let list = null
    for (let i = 0; i < 40 && !list; i++) {
      await wait(250)
      try { list = await getJson(port, '/json/list') } catch { /* 还没起来 */ }
    }
    const target = list?.find((t) => t.type === 'page')
    if (!target) throw new Error('拿不到 Chrome 调试页')

    const cdp = await connect(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width, height: VIEWPORT.height,
      deviceScaleFactor: VIEWPORT.scale, mobile: false,
    })

    for (const [route, out] of pages) {
      // 用 URL 解析再拼，避免 Windows 下路径分隔符混进 hash 路由
      let url
      try {
        url = new URL(route, BASE.endsWith('/') ? BASE : BASE + '/').href
      } catch {
        url = route.startsWith('http') ? route : `${BASE}/${route}`
      }
      await cdp.send('Page.navigate', { url })

      // 关键：等 React 真的渲染出内容，而不是等固定时间
      let ok = false
      for (let i = 0; i < 50; i++) {
        await wait(250)
        const r = await cdp.send('Runtime.evaluate', {
          expression: '(document.getElementById("root")||{}).innerHTML?.length||0',
          returnByValue: true,
        })
        if ((r.result?.result?.value || 0) > 2000) { ok = true; break }
      }
      if (!ok) {
        const errs = cdp.events
          .filter((e) => e.method === 'Runtime.exceptionThrown')
          .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
        console.error(`✗ ${route} 没渲染出来（多半是 JS 报错）`)
        if (errs.length) console.error(errs.slice(0, 3).join('\n---\n'))
        continue
      }

      await wait(900) // 等动画/字体落位
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const outPath = path.resolve(out)
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, Buffer.from(shot.result.data, 'base64'))
      console.log(`✓ ${outPath}  ←  ${url}`)
    }

    cdp.close()
  } finally {
    cleanup()
  }
}

main().catch((e) => { console.error('截图失败：', e.message); process.exit(1) })
