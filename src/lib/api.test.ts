import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetInUseError, api, logStreamUrl, resolveEngineOrigin } from '@/lib/api'

/** 记录发出去的请求，并按需要回一个响应 —— 用来钉住「接口的 URL / 动词 / 载荷」 */
function stubFetch(reply: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const { status = 200, body = {} } = reply(url, init)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      headers: new Headers(),
    } as unknown as Response
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('图像库客户端', () => {
  it('列表走 GET /api/images', async () => {
    const calls = stubFetch(() => ({ body: [{ id: 'img_a' }] }))

    await api.listImages()

    expect(calls[0].url).toBe('/api/images')
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
  })

  it('体检走 /api/images/audit —— 不能被 {id} 路由吞掉', async () => {
    const calls = stubFetch(() => ({ body: [] }))

    await api.auditImages()

    expect(calls[0].url).toBe('/api/images/audit')
  })

  it('引用查询带上素材 id', async () => {
    const calls = stubFetch(() => ({ body: [] }))

    await api.assetRefs('img_a')

    expect(calls[0].url).toBe('/api/images/img_a/references')
  })

  it('原图地址就是 /api/images/{id}/raw，前端 <img> 直接用', () => {
    expect(api.imageRawUrl('img_a')).toBe('/api/images/img_a/raw')
  })

  it('上传把文件与展示名一起放进 FormData', async () => {
    const calls = stubFetch(() => ({ body: { id: 'img_a' } }))
    const file = new File([new Uint8Array([1, 2, 3])], '按钮.png', { type: 'image/png' })

    await api.uploadImage(file, { name: '登录按钮', tag: '图标类', threshold: 0.9 })

    const fd = calls[0].init?.body as FormData
    expect(calls[0].url).toBe('/api/images')
    expect(calls[0].init?.method).toBe('POST')
    expect((fd.get('file') as File).name).toBe('按钮.png')
    expect(fd.get('name')).toBe('登录按钮')
    expect(fd.get('tag')).toBe('图标类')
    expect(fd.get('threshold')).toBe('0.9')
  })

  it('上传不传选项时不硬塞空字段', async () => {
    const calls = stubFetch(() => ({ body: { id: 'img_a' } }))

    await api.uploadImage(new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))

    const fd = calls[0].init?.body as FormData
    expect(fd.get('name')).toBeNull()
    expect(fd.get('tag')).toBeNull()
  })

  it('截图把区域摊平发出去', async () => {
    const calls = stubFetch(() => ({ body: { id: 'img_a' } }))

    await api.captureImage({ name: '登录按钮', x: 100, y: 200, width: 37, height: 12 })

    expect(calls[0].url).toBe('/api/images/capture')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      name: '登录按钮',
      x: 100,
      y: 200,
      width: 37,
      height: 12,
    })
  })

  it('改名用 PATCH，只发改动的那几项', async () => {
    const calls = stubFetch(() => ({ body: { id: 'img_a' } }))

    await api.updateImage('img_a', { threshold: 0.7 })

    expect(calls[0].url).toBe('/api/images/img_a')
    expect(calls[0].init?.method).toBe('PATCH')
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ threshold: 0.7 })
  })

  it('删除默认不带 force', async () => {
    const calls = stubFetch(() => ({ body: { deleted: true, clearedRefs: 0 } }))

    const r = await api.deleteImage('img_a')

    expect(calls[0].url).toBe('/api/images/img_a')
    expect(calls[0].init?.method).toBe('DELETE')
    expect(r).toEqual({ deleted: true, clearedRefs: 0 })
  })

  it('强制删除带上 force=true', async () => {
    const calls = stubFetch(() => ({ body: { deleted: true, clearedRefs: 2 } }))

    await api.deleteImage('img_a', { force: true })

    expect(calls[0].url).toBe('/api/images/img_a?force=true')
  })

  it('素材被引用时抛 AssetInUseError，并把引用清单带出来', async () => {
    stubFetch(() => ({
      status: 409,
      body: {
        message: '这张图正被 客服账号A的第 2 条指令 引用',
        refs: [{ instanceId: 'R1', instanceName: '客服账号A', cmdIndex: 1, cmdName: '图像-2' }],
      },
    }))

    const err = await api.deleteImage('img_a').then(
      () => null,
      (e: unknown) => e as AssetInUseError,
    )

    expect(err).toBeInstanceOf(AssetInUseError)
    expect(err!.refs[0]).toEqual({
      instanceId: 'R1',
      instanceName: '客服账号A',
      cmdIndex: 1,
      cmdName: '图像-2',
    })
    expect(err!.message).toContain('客服账号A')
  })

  it('删除不存在的素材抛普通错误，不当成「被引用」', async () => {
    stubFetch(() => ({ status: 404, body: { detail: '素材不存在' } }))

    const err = await api.deleteImage('img_x').then(
      () => null,
      (e: unknown) => e as Error,
    )

    expect(err).not.toBeInstanceOf(AssetInUseError)
  })
})

describe('引擎报的错原样带到界面', () => {
  /*
   * 后端把「为什么不行」写成了给人看的中文（`找不到文件：…`、`只支持 .xlsx / .xlsm，收到的是…`）。
   * 前端若只抛 `GET /excel/inspect?... failed: 404`，用户看到的是地址栏，不是人话 ——
   * 而这句人话恰恰是引擎唯一能解释清楚的地方。
   */
  it('抛出后端写的 detail，而不是请求 URL 加状态码', async () => {
    stubFetch(() => ({ status: 404, body: { detail: '找不到文件：D:\\表格\\订单.xlsx' } }))

    const err = await api.excelInspect('D:\\表格\\订单.xlsx').then(
      () => null,
      (e: unknown) => e as Error,
    )

    expect(err!.message).toBe('找不到文件：D:\\表格\\订单.xlsx')
  })

  it('后端没说话时退回一句带状态码的话，别把错误吞成空字符串', async () => {
    stubFetch(() => ({ status: 502, body: {} }))

    const err = await api.excelInspect('D:\\表格\\订单.xlsx').then(
      () => null,
      (e: unknown) => e as Error,
    )

    expect(err!.message).toContain('502')
  })
})

describe('引擎地址解析（打包/开发）', () => {
  it('打包后是 file:// 协议，走本机引擎绝对地址，端口来自 preload 注入', () => {
    expect(resolveEngineOrigin('file:', 9001)).toBe('http://127.0.0.1:9001')
  })

  it('开发态走同源相对路径（Vite 代理转发 /api 与 /ws）', () => {
    expect(resolveEngineOrigin('http:', 9001)).toBe('')
  })

  it('拿不到注入的端口时回退默认端口，而不是拼出 undefined', () => {
    expect(resolveEngineOrigin('file:', null)).toBe('http://127.0.0.1:8731')
  })
})

describe('日志 WebSocket 地址', () => {
  /*
   * 引擎的 WS 路由注册在 api router 上、又挂在 `/api` 前缀之下（`app.mount("/api", api)`），
   * 真实路径是 `/api/ws/instances/{id}/logs`。
   * 前端曾经连 `/ws/...`（少了 /api）→ 404，运行详情页的实时日志整条链路失效。
   */
  it('带 /api 前缀，与引擎挂载路径一致', () => {
    expect(logStreamUrl('I1')).toContain('/api/ws/instances/I1/logs')
  })
})

describe('对比表客户端', () => {
  it('删除对比表走 DELETE /api/instances/{id}/compare/table?name=...', async () => {
    const calls = stubFetch(() => ({ body: { ok: true } }))

    await api.removeCompareTable('R1', 'b2.xlsx')

    expect(calls[0].url).toBe('/api/instances/R1/compare/table?name=b2.xlsx')
    expect(calls[0].init?.method).toBe('DELETE')
  })
})

describe('桌面监控客户端', () => {
  it('命中事件走 GET /api/instances/{id}/monitor-hits', async () => {
    const calls = stubFetch(() => ({
      body: [{ assetId: 'img_a', similarity: 0.9, rect: [1, 2, 3, 4], ts: '2026-10-02 10:00:00' }],
    }))

    const hits = await api.monitorHits('M1')

    expect(calls[0].url).toBe('/api/instances/M1/monitor-hits')
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
    expect(hits[0].assetId).toBe('img_a')
    expect(hits[0].similarity).toBe(0.9)
    expect(hits[0].rect).toEqual([1, 2, 3, 4])
  })
})

describe('崩溃恢复客户端', () => {
  it('手动对账走 POST /api/instances/recover', async () => {
    const calls = stubFetch(() => ({ body: { recovered: 0, plans: [] } }))

    await api.recoverInstances()

    expect(calls[0].url).toBe('/api/instances/recover')
    expect(calls[0].init?.method).toBe('POST')
  })

  it('读启动恢复结果走 GET /api/instances/recovery', async () => {
    const calls = stubFetch(() => ({
      body: { recovered: 1, plans: [{ id: 'R1', name: '群发', from: 'running', to: 'idle', done: 3, total: 8 }] },
    }))

    const r = await api.recoverySummary()

    expect(calls[0].url).toBe('/api/instances/recovery')
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
    expect(r.recovered).toBe(1)
    expect(r.plans[0].to).toBe('idle')
    expect(r.plans[0].done).toBe(3)
  })
})

describe('速查填入客户端（/api/assist）', () => {
  it('读目标走 GET /api/assist/target', async () => {
    const calls = stubFetch(() => ({ body: { target: null } }))

    await api.assistTarget()

    expect(calls[0].url).toBe('/api/assist/target')
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
  })

  it('存目标走 PUT，载荷就是目标本身', async () => {
    const calls = stubFetch(() => ({ body: { target: null } }))
    const target = { window: '千牛', x: 1, y: 2, width: 30, height: 4 }

    await api.saveAssistTarget(target)

    expect(calls[0].url).toBe('/api/assist/target')
    expect(calls[0].init?.method).toBe('PUT')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(target)
  })

  it('填入把话术放在 text 字段里 POST /api/assist/fill', async () => {
    const calls = stubFetch(() => ({ body: { filled: true, window: '千牛' } }))

    await api.assistFill('运费由商家承担')

    expect(calls[0].url).toBe('/api/assist/fill')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: '运费由商家承担' })
  })

  it('窗口候选走 GET /api/assist/windows', async () => {
    const calls = stubFetch(() => ({ body: { windows: [], reason: '' } }))

    await api.assistWindows()

    expect(calls[0].url).toBe('/api/assist/windows')
  })

  it('填入被挡下来时，把引擎那句中文原样抛出来给用户看', async () => {
    // 「屏幕正被「跑批任务A」占用…」这种事必须让用户看见 —— 换成
    // `POST /api/assist/fill failed: 409` 他只会来问这个报错是什么意思
    stubFetch(() => ({ status: 409, body: { detail: '屏幕正被「跑批任务A」占用' } }))

    await expect(api.assistFill('您好')).rejects.toThrow(/跑批任务A/)
  })
})
