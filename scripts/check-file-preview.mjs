// 无前台：隔离 Chrome for Testing，生产构建与 CSP，真实文件面板 + 模拟核心。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.local/file-preview-check', `${Date.now()}-${process.pid}`)
mkdirSync(out, { recursive: true })
const binary = globSync(
  join(
    homedir(),
    'Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
)
  .sort()
  .at(-1)
assert(binary?.includes('for Testing'), '需要已安装的隔离 Chrome for Testing')
const profile = mkdtempSync(join(tmpdir(), 'litch-preview-chrome-'))
const home = join(profile, 'home')
mkdirSync(home)
const report = { checks: [], errors: [], requests: [], output: out }
let browser, server, cdp
try {
  await build({
    configFile: join(root, 'packages/ui/vite.config.ts'),
    root: join(root, 'packages/ui'),
    logLevel: 'warn',
    build: {
      outDir: join(out, 'assets'),
      rollupOptions: { input: join(root, 'packages/ui/test/preview/index.html') },
    },
  })
  const assets = join(out, 'assets')
  const mime = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.woff2': 'font/woff2',
    '.mjs': 'text/javascript',
  }
  server = createServer((req, res) => {
    const path = resolve(assets, `.${decodeURIComponent(req.url.split('?')[0])}`)
    if (!path.startsWith(`${assets}/`) || !existsSync(path)) {
      res.writeHead(404)
      res.end()
      return
    }
    res.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream')
    res.end(readFileSync(path))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  browser = spawn(
    binary,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      '--use-mock-keychain',
      '--password-store=basic',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    {
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir() },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let log = ''
  browser.stderr.on('data', (chunk) => {
    log += chunk
  })
  const ws = await until(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], 'Chrome CDP')
  const command = execFileSync('ps', ['-p', String(browser.pid), '-o', 'command='], {
    encoding: 'utf8',
  })
  assert(command.includes(`--user-data-dir=${profile}`) && command.includes('--headless=new'))
  cdp = await Cdp.connect(ws)
  const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, args) => cdp.call(method, args, sessionId)
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails)
      throw Error(
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails),
      )
    return result.result.value
  }
  cdp.listeners.add((event) => {
    if (event.sessionId !== sessionId) return
    if (event.method === 'Runtime.exceptionThrown')
      report.errors.push(event.params.exceptionDetails)
    if (event.method === 'Network.requestWillBeSent') report.requests.push(event.params.request.url)
  })
  await call('Runtime.enable')
  await call('Network.enable')
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Page.navigate', { url: `http://127.0.0.1:${port}/test/preview/index.html` })
  await until(
    () => evaluate('document.querySelector(".fp-document h1")?.textContent === "文件预览"'),
    'Markdown 已渲染',
  )
  report.checks.push('Markdown / StrictMode / 生产 CSP')
  assert.equal(await evaluate('Boolean(window.__previewLeak)'), false)
  assert.equal(await evaluate('document.querySelectorAll(".fp-document script").length'), 0)
  const security = await evaluate(`(() => { const f = window.previewCheck.svgInfo; return [
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://preview.invalid/a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
    '<!DOCTYPE svg [<!ENTITY a SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://preview.invalid/a";</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="x"/></svg>'
  ].every(s => f(s) === null) })()`)
  assert(security)
  report.checks.push('SVG 脚本/事件/foreignObject/实体/外链/动画拒绝')
  assert.equal(
    await evaluate(
      `window.previewCheck.documentTarget('/work', '/work/docs/a.md', '../../secret').kind`,
    ),
    'blocked',
  )
  assert.equal(
    await evaluate(
      `window.previewCheck.documentTarget('/work', '/work/docs/a.md', '%6aavascript:alert(1)').kind`,
    ),
    'blocked',
  )
  assert.equal(
    await evaluate(
      `window.previewCheck.documentTarget('/work', '/work/docs/a.md', './my%20file.md').path`,
    ),
    '/work/docs/my file.md',
  )
  report.checks.push('文档链接：空格、跨根和编码 scheme')
  await until(() => evaluate('document.querySelector(".mmd-fig svg") !== null'), 'Mermaid', 30000)
  const diagramSize = `(() => {
    const svg = document.querySelector('.fp-document .mmd-fig svg');
    return {
      font: getComputedStyle(svg.querySelector('text')).fontSize,
      box: svg.getAttribute('viewBox'),
      body: getComputedStyle(document.querySelector('.fp-document p')).fontSize
    };
  })()`
  const normalDiagram = await evaluate(diagramSize)
  await evaluate(`window.previewDiagram = document.querySelector('.fp-document .mmd-fig svg');
    window.__litchLook.set({chatText: 1.5})`)
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.deepEqual(await evaluate(diagramSize), normalDiagram)
  assert(
    await evaluate('window.previewDiagram === document.querySelector(".fp-document .mmd-fig svg")'),
    '对话字号变化不得重画文件预览 Mermaid',
  )
  await evaluate(`window.previewCheck.markdown('docs/images/font-scale.md',
    '# 字号验收\\n\\n正文\\n\\n\x60\x60\x60mermaid\\ngraph LR\\n A[字体测试] --> B[固定字号]\\n\x60\x60\x60')`)
  await until(
    () =>
      evaluate(
        'document.querySelector(".fp-document h1")?.textContent === "字号验收" && !!document.querySelector(".mmd-fig svg")',
      ),
    '放大对话字号后首次打开文档图表',
  )
  const enlargedSettingDiagram = await evaluate(diagramSize)
  assert.equal(enlargedSettingDiagram.font, normalDiagram.font)
  await evaluate('window.__litchLook.set({chatText: 1})')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(await evaluate(diagramSize), enlargedSettingDiagram)
  report.checks.push('Mermaid 文档字号固定：100%/150% 切换不重画，150% 首次打开仍为默认尺寸')
  await evaluate(`window.previewCheck.open('docs/images/preview.md')`)
  await until(
    () =>
      evaluate(
        'document.querySelector(".fp-document h1")?.textContent === "文件预览" && !!document.querySelector(".mmd-fig svg")',
      ),
    '恢复文档图表',
  )
  await evaluate('document.querySelector(".fp-document").scrollTop = 10000')
  await until(
    () => evaluate('document.querySelector(".fp-inline-image")?.naturalWidth > 0'),
    '相对 SVG 图片',
  )
  assert(!report.requests.some((url) => url.includes('preview.invalid')))
  report.checks.push('相对图片、Mermaid、外链不取')
  await evaluate(`window.previewBefore = {
    node: document.querySelector('.fp-document'),
    image: document.querySelector('.fp-inline-image')?.src,
    scroll: document.querySelector('.fp-document').scrollTop,
    reads: window.previewCheck.readCount('docs/images/preview.md')
  }; window.previewCheck.rerenderParent()`)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert(
    await evaluate(`window.previewBefore.node === document.querySelector('.fp-document') &&
    window.previewBefore.image === document.querySelector('.fp-inline-image')?.src &&
    window.previewBefore.scroll === document.querySelector('.fp-document').scrollTop &&
    window.previewBefore.reads === window.previewCheck.readCount('docs/images/preview.md')`),
    '父重渲染不得重挂成功预览、丢滚动位置或重解码附图',
  )
  for (const kind of ['tooLarge', 'outside', 'busy']) {
    const file = `docs/images/rejected-${kind}.md`
    await evaluate(
      `window.previewCheck.result(${JSON.stringify(file)}, ${JSON.stringify(kind === 'tooLarge' ? { kind, bytes: 1048576, limit: 524288 } : { kind })}); window.previewCheck.open(${JSON.stringify(file)})`,
    )
    await until(
      () => evaluate(`document.querySelector('.fp')?.dataset.kind === ${JSON.stringify(kind)}`),
      '拒绝预览已显示',
    )
    const reads = await evaluate(`window.previewCheck.readCount(${JSON.stringify(file)})`)
    await evaluate('window.previewCheck.rerenderParent()')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(
      await evaluate(`window.previewCheck.readCount(${JSON.stringify(file)})`),
      reads,
      `${kind} 父重渲染不得重复请求设备`,
    )
  }
  report.checks.push('父重渲染保留成功预览，拒绝结果不重复读取')
  await evaluate(`window.previewCheck.open('docs/images/preview.md')`)
  await until(() => evaluate('!!document.querySelector(".fp-document h1")'), '返回文档')
  for (let attempt = 0; attempt < 2; attempt++) {
    await evaluate('document.querySelector(".fp-document").scrollTop = 0')
    await evaluate(
      'Array.from(document.querySelectorAll(".fp-document a")).find(a => a.textContent === "跳到标题").click()',
    )
    await until(
      () => evaluate('document.querySelector(".fp-document").scrollTop > 30'),
      '重复标题跳转',
    )
  }
  report.checks.push('同一标题重复点击重新定位')
  const headingDocument =
    '# Root\n\n[first](#root) · [duplicate](#root-1)\n\n' +
    '正文段落\n\n'.repeat(30) +
    '## Root\n\n文档末尾。'
  await evaluate(
    `window.previewCheck.markdown('docs/images/heading-ids.md', ${JSON.stringify(headingDocument)})`,
  )
  await until(
    () => evaluate('document.querySelector(".fp-document h1")?.id === "fp-h-root"'),
    '标题使用独立 id 前缀',
  )
  assert.equal(await evaluate('document.querySelectorAll("#root").length'), 1)
  assert(await evaluate('!!document.querySelector(".fp-document #fp-h-root-1")'))
  await evaluate(
    'Array.from(document.querySelectorAll(".fp-document a")).find(a => a.textContent === "duplicate").click()',
  )
  await until(
    () => evaluate('document.querySelector(".fp-document").scrollTop > 30'),
    '带前缀的重名标题跳转',
  )
  assert.equal(
    await evaluate('document.querySelector(".fv-foot .ell").textContent.includes("markdown")'),
    false,
  )
  report.checks.push('标题 id 不冲突，重名标题锚点生效，页脚无内部格式名')
  await evaluate(`window.previewCheck.open('docs/images/preview.md')`)
  await until(
    () => evaluate('document.querySelector(".fp-document h1")?.textContent === "文件预览"'),
    '恢复视觉文档',
  )
  await evaluate('document.querySelector(".fp-document").scrollTop = 0')
  for (const skin of ['standard', 'retro', 'human'])
    for (const theme of ['light', 'dark']) {
      await evaluate(`window.__litchLook.set(${JSON.stringify({ skin, theme, lang: 'zh-CN' })})`)
      await new Promise((resolve) => setTimeout(resolve, 250))
      const shot = await call('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(out, `${skin}-${theme}.png`), Buffer.from(shot.data, 'base64'))
    }
  report.checks.push('三皮肤 × 深浅两色截图')
  await evaluate(`window.previewCheck.open('docs/images/preview.md', 4)`)
  await until(() => evaluate('!!document.querySelector(".fv-code")'), '行号切源码')
  report.checks.push('带行号链接切源码')
  for (let i = 0; i < 50; i++) {
    await evaluate(`window.previewCheck.open('docs/images/preview.svg')`)
    await until(
      () => evaluate('document.querySelector(".fp-image-stage img")?.naturalWidth === 480'),
      'SVG',
    )
    await evaluate(`window.previewCheck.open('docs/images/unsafe.svg')`)
    await until(
      () => evaluate('document.querySelector(".fp .fv-hold")?.textContent?.includes("图片无效")'),
      '恶意 SVG 占位',
    )
  }
  assert.equal(await evaluate('window.previewCheck.liveUrls()'), 0)
  assert.equal(await evaluate('Boolean(window.__previewLeak)'), false)
  report.checks.push('50 次图片切换后无 Blob URL 泄漏')
  await evaluate(`window.previewCheck.open('docs/images/preview.md')`)
  // 上一次行号模式被标签替换清除，新文档默认预览。
  await until(() => evaluate('!!document.querySelector(".fp-document h1")'), '返回 Markdown')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 480,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })
  writeFileSync(
    join(out, 'narrow.png'),
    Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  )
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors))
  report.success = true
} finally {
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
  cdp?.close()
  if (browser && browser.exitCode === null) {
    const stopped = new Promise((resolve) => browser.once('exit', resolve))
    browser.kill('SIGTERM')
    await stopped
  }
  server?.close()
  rmSync(profile, { recursive: true, force: true })
  console.log(
    JSON.stringify({
      output: out,
      checks: report.checks,
      errors: report.errors.length,
      success: report.success ?? false,
    }),
  )
}
