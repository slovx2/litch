// check-preview-web.mjs 的子进程；窗口始终隐藏，脚本不发送系统输入。
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { app, BrowserWindow, protocol, session } from 'electron'

const out = process.argv[2],
  home = process.env.LITCH_PREVIEW_CHECK_HOME
if (!out || !home) throw Error('只允许隔离夹具启动')
app.setPath('userData', join(home, 'userData'))
app.setPath('sessionData', join(home, 'sessionData'))
app.disableHardwareAcceleration()
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])
const report = { checks: [], media: [], versions: process.versions, requests: [], errors: [] }
let win
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const wait = async (fn, label) => {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return
    await sleep(50)
  }
  throw Error(`超时：${label}`)
}
const js = (expression) => win.webContents.executeJavaScript(expression)
const open = async (path, format, bytes) => {
  await js(
    `window.previewWeb.seed(${JSON.stringify(path)},${JSON.stringify(format)},${JSON.stringify(Buffer.from(bytes).toString('base64'))});window.previewWeb.open(${JSON.stringify(path)})`,
  )
}
const check = (name) => {
  report.checks.push(name)
  console.log(`PASS ${name}`)
}
const shots = async (prefix) => {
  for (const skin of ['standard', 'retro', 'human'])
    for (const theme of ['light', 'dark']) {
      await js(
        `window.__litchLook.set({skin:${JSON.stringify(skin)},theme:${JSON.stringify(theme)}})`,
      )
      await sleep(100)
      writeFileSync(
        join(out, `${prefix}-${skin}-${theme}.png`),
        (await win.webContents.capturePage()).toPNG(),
      )
    }
  win.setSize(560, 760)
  await sleep(100)
  writeFileSync(join(out, `${prefix}-narrow.png`), (await win.webContents.capturePage()).toPNG())
  win.setSize(1100, 850)
}
void app.whenReady().then(async () => {
  try {
    app.dock?.hide()
    const assets = join(out, 'assets')
    protocol.handle('app', (request) => {
      const url = new URL(request.url),
        path = resolve(assets, `.${decodeURIComponent(url.pathname)}`)
      if (!path.startsWith(`${assets}/`)) return new Response('', { status: 403 })
      const types = {
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.html': 'text/html',
        '.woff2': 'font/woff2',
        '.wasm': 'application/wasm',
      }
      return new Response(readFileSync(path), {
        headers: { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' },
      })
    })
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      report.requests.push(details.url)
      callback({
        cancel: !details.url.startsWith('app://preview/') && !details.url.startsWith('blob:'),
      })
    })
    win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 850,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('did-fail-load', (_, code, text) => report.errors.push({ code, text }))
    win.webContents.on('console-message', (event) => {
      console.log('renderer:', event.level, event.message)
    })
    await win.loadURL('app://preview/test/preview-web/index.html')
    await wait(() => js('Boolean(window.previewWeb)'), '夹具就绪')
    assert.equal(win.isVisible(), false)
    check('Electron 生产构建 / sandbox / 始终隐藏')
    await open(
      'sample.csv',
      'csv',
      '名称,编号,内容\n中文,900719925474099312345,"字段内\n换行"\n公式,=cmd|calc,"<img src=x onerror=alert(1)>"',
    )
    await wait(() => js('Boolean(document.querySelector(".fp-csv-grid"))'), 'CSV Worker')
    assert.equal(await js('document.querySelectorAll(".fp-csv-grid img").length'), 0)
    assert.equal(
      await js(
        'document.querySelector(".fp-csv-grid").innerText.includes("900719925474099312345")',
      ),
      true,
    )
    check('CSV Worker / 字符串 / 公式与 HTML 不执行')
    await shots('csv')
    const giant = Array.from({ length: 10001 }, (_, r) =>
      Array.from({ length: 101 }, () => String(r % 10)).join(','),
    ).join('\n')
    await open('large.tsv', 'csv', giant.replaceAll(',', '\t'))
    await wait(
      () => js('document.querySelector(".fp-csv-grid")?.getAttribute("aria-rowcount")==="10001"'),
      '表格限额',
    )
    assert.ok(await js('document.querySelectorAll(".fp-csv-row").length < 45'))
    await js('document.querySelector(".fp-csv-viewport").scrollTo(12000,200000)')
    await sleep(100)
    assert.ok(
      await js(
        'Number(document.querySelector(".fp-csv-row").getAttribute("aria-rowindex")) > 7000',
      ),
    )
    assert.ok(await js('document.querySelectorAll(".fp-csv-cell").length < 700'))
    check('CSV 10,000行/100列截断 / 双向虚拟化')
    await open('long-cell.csv', 'csv', `a,b\n${'x'.repeat(1_000_000)},ok`)
    await wait(
      () => js('document.querySelector(".fp-csv-grid")?.innerText.includes("ok")'),
      '长字段',
    )
    assert.ok(await js('document.querySelector(".fp-csv-grid").textContent.length < 5000'))
    check('CSV 百万字符字段不进入主线程无界排版，原值保留供源码查看')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xoAAAAASUVORK5CYII=',
      'base64',
    )
    await js(
      `window.previewWeb.seed('local.png','image',${JSON.stringify(png.toString('base64'))})`,
    )
    const html = `<!doctype html><html><head><base href="https://preview.invalid/"><meta http-equiv="refresh" content="0;url=https://preview.invalid/refresh"><style>body{color:#173152;background:#fafafa}h1{font-size:28px}table{border-collapse:collapse}td{border:1px solid #aaa;padding:8px}@import url(https://preview.invalid/import);p{background-image:url(https://preview.invalid/css)}</style></head><body><h1>静态报告</h1><p>只能查看内容，脚本与外部资源被禁用。</p><script>parent.__previewLeak=1;fetch('https://preview.invalid/script')</script><form action="https://preview.invalid/form"><input autofocus onfocus="parent.__previewLeak=2"><button>提交</button></form><iframe src="https://preview.invalid/frame"></iframe><object data="https://preview.invalid/object"></object><a href="javascript:parent.__previewLeak=3" download target="_top">不可导航</a><img src="local.png" onload="parent.__previewLeak=4"><img src="https://preview.invalid/image"><img src="../../outside.png"><img src="data:image/png;base64,${png.toString('base64')}" alt="原文data拒绝"><div style="background:u\\72l(https://preview.invalid/escaped);color:red">样式安全</div><table><tr><td>指标</td><td>结果</td></tr><tr><td>覆盖率</td><td>98%</td></tr></table></body></html>`
    await open('report.html', 'html', html)
    await wait(() => js('Boolean(document.querySelector(".fp-html-frame")?.srcdoc)'), 'HTML iframe')
    const source = await js('document.querySelector(".fp-html-frame").srcdoc')
    assert.equal(await js('document.querySelector(".fp-html-frame").getAttribute("sandbox")'), '')
    for (const bad of [
      '<script',
      '<base',
      'http-equiv="refresh"',
      '<form',
      '<iframe',
      '<object',
      'onload=',
      'onfocus=',
      'href=',
      '@import',
      'preview.invalid',
    ])
      assert.equal(source.includes(bad), false, bad)
    assert.ok(source.includes('src="data:image/png;base64,'))
    assert.equal(
      (source.match(/src="data:/g) ?? []).length,
      1,
      '只允许重写的根内图片，原始 data 图片拒绝',
    )
    await sleep(300)
    assert.equal(
      await js('document.querySelector(".fp-html-frame").contentDocument'),
      null,
      '空 sandbox 不可同源访问',
    )
    win.webContents.debugger.attach('1.3')
    let snapshot = await win.webContents.debugger.sendCommand('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
    })
    const { targetInfos } = await win.webContents.debugger.sendCommand('Target.getTargets')
    const iframeTarget = targetInfos.find((target) => target.type === 'iframe')
    if (iframeTarget) {
      const { sessionId } = await win.webContents.debugger.sendCommand('Target.attachToTarget', {
        targetId: iframeTarget.targetId,
        flatten: true,
      })
      snapshot = await win.webContents.debugger.sendCommand(
        'DOMSnapshot.captureSnapshot',
        { computedStyles: [] },
        sessionId,
      )
    }
    const framed = snapshot.documents.find(
      (doc) => snapshot.strings[doc.documentURL] === 'about:srcdoc',
    )
    console.log(
      'snapshot urls',
      snapshot.documents.map((doc) => snapshot.strings[doc.documentURL]),
    )
    assert.ok(framed, 'srcdoc 文档已装载')
    const imageIndex = framed.nodes.nodeName.findIndex((name) => snapshot.strings[name] === 'IMG')
    const imageLayout = framed.layout.nodeIndex.indexOf(imageIndex)
    assert.equal(framed.layout.bounds[imageLayout][2], 1, '根内图实际解码为 1 像素，不能是破图占位')
    win.webContents.debugger.detach()
    assert.equal(await js('Boolean(window.__previewLeak)'), false)
    assert.equal(
      (await js('window.previewWeb.reads()')).some((path) => path.includes('outside')),
      false,
    )
    await sleep(250)
    assert.equal(
      report.requests.some((url) => url.includes('preview.invalid')),
      false,
    )
    check(
      'HTML 空 sandbox srcdoc / 净化 / CSP / 根内 data 图片实解码 / 原始 data 拒绝 / 零外链请求',
    )
    await shots('html')
    for (const file of ['tone.wav', 'tone.mp3', 'clip.mp4', 'clip.webm']) {
      await open(file, 'media', readFileSync(join(out, file)))
      await wait(
        () =>
          js(
            'Boolean(document.querySelector("audio,video")?.readyState >= 1 || document.querySelector(".fv-hold")?.textContent.includes("无法播放"))',
          ),
        file,
      )
      await sleep(150)
      const status = await js(
        `(()=>{const p=document.querySelector('audio,video');return p?{duration:p.duration,paused:p.paused,autoplay:p.autoplay,error:p.error?.code??null,ready:p.readyState}:{unsupported:true}})()`,
      )
      report.media.push({ file, ...status })
      assert.ok(!status.unsupported && status.ready >= 1 && !status.error, JSON.stringify(status))
      assert.equal(status.autoplay, false)
      assert.equal(status.paused, true)
      await js(
        'window.oldMedia=document.querySelector("audio,video");window.oldMedia.muted=true;window.oldMedia.play()',
      )
      await wait(() => js('window.oldMedia.currentTime > 0'), '播放时钟推进')
      if (file === 'clip.mp4') {
        await js('window.oldMedia.pause()')
        await shots('media')
        await js('window.oldMedia.play()')
      }
      await js('window.previewWeb.close()')
      await sleep(100)
      assert.equal(await js('window.oldMedia.paused && !window.oldMedia.getAttribute("src")'), true)
      assert.deepEqual(await js('window.previewWeb.live()'), { urls: 0, workers: 0 })
    }
    check('MP3/WAV/H264+AAC MP4/VP9+Opus WebM 实际解码与播放 / 关闭停止并释放')
    const pixels = readFileSync(join(out, 'pixels.png')).toString('base64')
    for (const name of ['pixel1.png', 'pixel2.png', 'pixel3.png'])
      await js(`window.previewWeb.seed(${JSON.stringify(name)},'image',${JSON.stringify(pixels)})`)
    await open(
      'pixels.html',
      'html',
      '<img src="pixel1.png"><img src="pixel2.png"><img src="pixel3.png">',
    )
    await wait(
      () => js('document.querySelector(".fp-html-frame")?.srcdoc.includes("图片未加载")'),
      '累计像素预算',
    )
    assert.equal(
      await js('(document.querySelector(".fp-html-frame").srcdoc.match(/src="data:/g)??[]).length'),
      2,
    )
    const padded = Buffer.alloc(8 * 1024 * 1024)
    png.copy(padded)
    for (const name of ['bytes1.png', 'bytes2.png', 'bytes3.png'])
      await js(
        `window.previewWeb.seed(${JSON.stringify(name)},'image',${JSON.stringify(padded.toString('base64'))})`,
      )
    await open(
      'bytes.html',
      'html',
      '<img src="bytes1.png"><img src="bytes2.png"><img src="bytes3.png">',
    )
    await wait(
      () => js('document.querySelector(".fp-html-frame")?.srcdoc.includes("图片未加载")'),
      '累计字节预算',
    )
    assert.equal(
      await js('(document.querySelector(".fp-html-frame").srcdoc.match(/src="data:/g)??[]).length'),
      2,
    )
    assert.equal(
      (await js('window.previewWeb.reads()')).some((path) => path.endsWith('/bytes3.png')),
      false,
    )
    check('HTML 重写 data 附图仍受 16 MiB / 40 百万像素累计预算约束')
    const readsBeforeRepeat = (await js('window.previewWeb.reads()')).filter((path) =>
      path.endsWith('/bytes1.png'),
    ).length
    await open('repeated.html', 'html', `<h2>重复附图</h2>${'<img src="bytes1.png">'.repeat(3)}`)
    await wait(
      () => js('document.querySelector(".fp-html-frame")?.srcdoc.includes("重复附图")'),
      '重复附图',
    )
    const repeated = await js(
      `(()=>{const source=document.querySelector('.fp-html-frame').srcdoc;return {count:(source.match(/src="data:/g)??[]).length,bytes:source.length}})()`,
    )
    const css = await js(`(()=>{
      const style='border:1px solid red;text-decoration:underline solid blue;border-radius:8px;white-space:pre-wrap;grid-column:2 / span 3';
      const result=window.previewWeb.html('<style>.sample{'+style+'}</style><p class="sample" style="'+style+'">样式</p>');
      const template=document.createElement('template');template.innerHTML=result;
      const inline=template.content.querySelector('p').style;
      const sheet=new CSSStyleSheet();sheet.replaceSync(Array.from(template.content.querySelectorAll('style')).at(-1).textContent);
      const properties=['border-top-width','text-decoration-line','border-top-left-radius','white-space','grid-column'];
      return [inline,sheet.cssRules[0]?.style].map(value=>properties.map(name=>value?.getPropertyValue(name)??''));
    })()`)
    // 同时记录两种失败，避免旧实现的内联膨胀掩盖样式回归。
    assert.deepEqual(
      { images: repeated.count, css },
      {
        images: 2,
        css: Array.from({ length: 2 }, () => ['1px', 'underline', '8px', 'pre-wrap', '2 / span 3']),
      },
    )
    assert.ok(
      repeated.bytes < 23 * 1024 * 1024,
      '16 MiB 原图预算对应约 22 MiB base64，不随缓存命中膨胀',
    )
    assert.equal(
      (await js('window.previewWeb.reads()')).filter((path) => path.endsWith('/bytes1.png'))
        .length - readsBeforeRepeat,
      1,
      '重复资源仍只读取一次',
    )
    await open(
      'repeated-pixels.html',
      'html',
      `<h2>重复像素</h2>${'<img src="pixel1.png">'.repeat(3)}`,
    )
    await wait(
      () => js('document.querySelector(".fp-html-frame")?.srcdoc.includes("重复像素")'),
      '重复像素',
    )
    assert.equal(
      await js('(document.querySelector(".fp-html-frame").srcdoc.match(/src="data:/g)??[]).length'),
      2,
    )
    check('HTML 重复引用逐次计入内联字节/像素预算；内联与样式表简写保留')

    // 刷新必须替换文档；坏结构、坏编码、损坏媒体和设备超限都有可见回退。
    await open('refresh.html', 'html', '<h1>旧内容</h1>')
    await wait(
      () => js('document.querySelector(".fp-html-frame")?.srcdoc.includes("旧内容")'),
      '旧文档',
    )
    await js(
      `window.previewWeb.seed('refresh.html','html',${JSON.stringify(Buffer.from('<h1>新内容</h1>').toString('base64'))});document.querySelector('[data-tool="reload"]').click()`,
    )
    await wait(
      () => js('document.querySelector(".fp-html-frame")?.srcdoc.includes("新内容")'),
      '刷新',
    )
    await open('deep.html', 'html', `${'<div>'.repeat(70)}too deep${'</div>'.repeat(70)}`)
    await wait(
      () => js('document.querySelector(".fv-hold")?.innerText.includes("HTML")'),
      'DOM 深度预算',
    )
    await open('broken.csv', 'csv', Buffer.from([0xff, 0xfe]))
    await wait(
      () => js('document.querySelector(".fv-hold")?.innerText.includes("UTF-8")'),
      '无效 CSV 编码',
    )
    await open('broken.mp4', 'media', Buffer.from('not a movie'))
    await wait(
      () => js('document.querySelector(".fv-hold")?.innerText.includes("无法播放")'),
      '损坏媒体',
    )
    for (const file of ['limit.csv', 'limit.html', 'limit.mp4']) {
      await js(
        `window.previewWeb.failure(${JSON.stringify(file)},'tooLarge');window.previewWeb.open(${JSON.stringify(file)})`,
      )
      await wait(
        () => js('document.querySelector(".fp")?.dataset.kind === "tooLarge"'),
        '设备拒绝超限',
      )
    }
    check('刷新/损坏/编码/DOM 预算/设备超限回退')
    for (let i = 0; i < 50; i++) {
      await open(`loop-${i}.csv`, 'csv', 'a,b\n1,2')
      await js('window.previewWeb.close()')
      await open(`loop-${i}.html`, 'html', '<h1>取消</h1><img src="local.png">')
      await wait(() => js('Boolean(document.querySelector(".fp-html-frame"))'), '附图')
      await js('window.previewWeb.close()')
    }
    await sleep(150)
    assert.deepEqual(await js('window.previewWeb.live()'), { urls: 0, workers: 0 })
    check('50 次切换与取消 / Worker 与 Blob URL 无残留')
    assert.equal(win.isVisible(), false)
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
    win.destroy()
    app.exit(0)
  } catch (error) {
    report.errors.push(String(error))
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
    console.error(error)
    win?.destroy()
    app.exit(1)
  }
})
