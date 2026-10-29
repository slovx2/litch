import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from './chrome-m0/cdp.mjs'

export async function checkPdf({ evaluate, call, report, out, pdfFixture }) {
  await until(() => evaluate('!!window.pdfCheck'), 'PDF 夹具初始化')
  const fontsBefore = await evaluate(
    'Array.from(document.fonts).filter(f => f.family.startsWith("g_d")).length',
  )
  const open = async (name, data, bytes) =>
    evaluate(
      `window.pdfCheck.open(${JSON.stringify(name)}, ${JSON.stringify(data.toString('base64'))}, ${bytes ?? data.length})`,
    )
  const ready = (number = 1) =>
    until(
      () =>
        evaluate(
          `document.querySelector('.fp-pdf-page[data-page="${number}"]')?.dataset.state === 'ready'`,
        ),
      `PDF 第 ${number} 页`,
      30000,
    )
  const fixture = pdfFixture()
  await open('sample.pdf', fixture)
  await ready()
  assert.equal(await evaluate('window.pdfCheck.workers()'), 1)
  assert(
    (await evaluate('document.querySelector(".fp-pdf-text").textContent')).includes('中文文件预览'),
  )
  assert(
    await evaluate(`(() => {
    const canvas = document.querySelector('.fp-pdf-page canvas');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 !== 3 && value < 200);
  })()`),
    'PDF 文字和扫描图像实际绘制',
  )
  await evaluate(
    `(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('.fp-pdf-text')); getSelection().removeAllRanges(); getSelection().addRange(range); })()`,
  )
  assert((await evaluate('getSelection().toString()')).includes('Litch PDF preview'))
  await evaluate('getSelection().removeAllRanges()')
  report.checks.push('协议字节 → 本地 Worker，中文 CMap/英文字体、扫描图、可选择文字层')
  assert((await evaluate("window.pdfCheck.asset('wasmUrl', 'openjpeg.wasm')")) > 0)
  assert((await evaluate("window.pdfCheck.asset('wasmUrl', 'jbig2.wasm')")) > 0)
  assert((await evaluate("window.pdfCheck.asset('wasmUrl', 'qcms_bg.wasm')")) > 0)
  assert(
    await evaluate("window.pdfCheck.asset('cMapUrl', '../LICENSE').then(() => false, () => true)"),
  )
  assert(
    await evaluate(
      "window.pdfCheck.asset('wasmUrl', 'quickjs-eval.wasm').then(() => false, () => true)",
    ),
  )
  const csp = await evaluate(
    'document.querySelector("meta[http-equiv=Content-Security-Policy]").content',
  )
  assert(
    csp.includes("connect-src 'none'") &&
      csp.includes("worker-src 'self'") &&
      csp.includes("'wasm-unsafe-eval'"),
  )
  report.csp = csp
  assert(await evaluate(`fetch('https://pdf.invalid/network').then(() => false, () => true)`))
  assert(await evaluate(`Promise.resolve().then(() => eval('1')).then(() => false, () => true)`))
  await until(
    () =>
      evaluate(
        `window.pdfCheck.violations().includes('connect-src') && window.pdfCheck.violations().includes('script-src')`,
      ),
    '生产 CSP 拒绝事件',
  )
  assert(
    await evaluate(`WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(() => true)`),
  )
  report.checks.push(
    '生产 CSP：网络与 JS eval 拒绝，本地 WASM 可编译；资源白名单拒绝跨目录和脚本执行器',
  )
  for (const skin of ['standard', 'retro', 'human'])
    for (const theme of ['light', 'dark']) {
      await evaluate(`window.__litchLook.set(${JSON.stringify({ skin, theme, lang: 'zh-CN' })})`)
      const shot = await call('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(out, `${skin}-${theme}.png`), Buffer.from(shot.data, 'base64'))
    }
  await call('Emulation.setDeviceMetricsOverride', {
    width: 480,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await until(
    () => evaluate('document.querySelector(".fp-pdf-scroll").clientWidth < 480'),
    '窄面板布局',
  )
  const narrow = await call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(out, 'narrow.png'), Buffer.from(narrow.data, 'base64'))
  assert(
    await evaluate(
      `Array.from(document.querySelectorAll('.fp-pdf-tools button,input')).every(e => e.getBoundingClientRect().right <= 480)`,
    ),
  )
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluate('document.querySelector("[data-pdf=next]").click()')
  await ready(2)
  assert(
    await evaluate(
      `(() => { const r = document.querySelector('.fp-pdf-page[data-page="2"]').getBoundingClientRect(); return r.width > r.height })()`,
    ),
  )
  const width = await evaluate(`document.querySelector('.fp-pdf-page[data-page="2"] canvas').width`)
  await evaluate('document.querySelector("[data-pdf=in]").click()')
  await ready(2)
  assert(
    (await evaluate(`document.querySelector('.fp-pdf-page[data-page="2"] canvas').width`)) > width,
  )
  report.checks.push('三皮肤 × 深浅截图，旋转页面、翻页与缩放')
  await open('wasm-scan.pdf', pdfFixture({ pages: 1, jpx: true }))
  await ready()
  assert(
    await evaluate(`(() => {
    const c = document.querySelector('.fp-pdf-page canvas');
    const color = c.getContext('2d').getImageData(Math.round(c.width / 6), Math.round(c.height * 0.4), 1, 1).data;
    return color[0] > 50 && color[0] < 120 && color[3] === 255;
  })()`),
    'JPEG2000 扫描图经本地 WASM 正确解码',
  )
  report.checks.push('JPEG2000 扫描图通过本地 Worker/WASM 解码并校验像素')
  await open('long.pdf', pdfFixture({ pages: 200, cjk: false }))
  await ready()
  await evaluate(
    'window.pdfOldCanvas = document.querySelector(".fp-pdf-page canvas"); document.querySelector(".fp-pdf-scroll").scrollTop = 10000000',
  )
  await ready(200)
  assert.equal(await evaluate('window.pdfOldCanvas.width'), 0)
  assert((await evaluate('document.querySelectorAll(".fp-pdf-page").length')) <= 4)
  assert(
    (await evaluate(
      'Array.from(document.querySelectorAll(".fp-pdf-page canvas")).reduce((n,c) => n+c.width*c.height,0)',
    )) <= 16_000_000,
  )
  report.checks.push('200 页滚动到末页，仅保留可见及邻页，离屏画布清零，总画布像素受限')
  for (const [name, data, error, bytes] of [
    ['broken.pdf', Buffer.from('%PDF-1.7\nnot a document'), 'invalid'],
    ['password.pdf', pdfFixture({ encrypted: true }), 'encrypted'],
    ['too-many.pdf', pdfFixture({ pages: 201 }), 'pages'],
    ['too-wide.pdf', pdfFixture({ huge: true }), 'size'],
    ['too-big.pdf', fixture, 'size', 20 * 1024 * 1024 + 1],
  ]) {
    await open(name, data, bytes)
    await until(
      () => evaluate(`document.querySelector('[data-pdf-error]')?.dataset.pdfError === '${error}'`),
      name,
    )
    assert.equal(await evaluate('window.pdfCheck.workers()'), 0)
  }
  report.checks.push('损坏、密码、201 页、过大页面、20 MiB 超限占位且释放 Worker')
  await open('text-limit.pdf', pdfFixture({ pages: 1, longText: true }))
  await until(
    () => evaluate('document.querySelector(".fp-pdf-page")?.dataset.state === "textLimit"'),
    '文字层预算',
    30000,
  )
  assert.equal(await evaluate('document.querySelectorAll(".fp-pdf-text span").length'), 0)
  report.checks.push('文字层预算在创建 DOM 前生效，保留页面图像')
  for (let i = 0; i < 50; i++) {
    report.switchIteration = i
    await open(`cancel-${i}.pdf`, fixture)
    if (i % 10 === 0) await ready()
    await evaluate('window.pdfCheck.leave()')
  }
  await until(() => evaluate('window.pdfCheck.workers() === 0'), '快速切换取消')
  await evaluate('window.pdfCheck.freeze(true)')
  await open('timeout.pdf', fixture)
  await until(
    () => evaluate('document.querySelector("[data-pdf-error]")?.dataset.pdfError === "timeout"'),
    '解析超时强制终止',
    25000,
  )
  assert.equal(await evaluate('window.pdfCheck.workers()'), 0)
  await evaluate('window.pdfCheck.freeze(false)')
  report.checks.push('解析 20 秒超时强制终止，50 次文件切换释放 Worker 和字体')
  await open('last.pdf', fixture)
  await ready()
  await evaluate('document.querySelector("[data-tool=reload]").click()')
  await ready()
  assert.equal(await evaluate('window.pdfCheck.workers()'), 1)
  assert.equal(await evaluate('!!window.__pdfScriptExecuted'), false)
  assert.equal(
    await evaluate(
      'document.querySelectorAll(".fp-pdf a,.fp-pdf iframe,.fp-pdf input[type=button]").length',
    ),
    0,
  )
  await evaluate('window.pdfCheck.leave()')
  await until(() => evaluate('window.pdfCheck.workers() === 0'), '关闭释放')
  assert.equal(
    await evaluate('Array.from(document.fonts).filter(f => f.family.startsWith("g_d")).length'),
    fontsBefore,
  )
  report.checks.push('快速切换、刷新、关闭释放；文档 JavaScript/外链动作/表单不执行')
  // 探针已通过 securitypolicyviolation 核验；被 CSP 拦在网络请求前。
  assert.equal(report.requests.filter((url) => url.includes('pdf.invalid')).length, 0)
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors))
  report.success = true
}
