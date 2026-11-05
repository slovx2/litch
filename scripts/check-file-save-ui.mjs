// 隔离 headless Chrome + 模拟核心。只用本机对话框/传输替身，不保存截图或操作日用浏览器。
// 先安装根目录与 packages/ui 依赖，运行 node scripts/check-file-save-ui.mjs。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const binary = globSync(
  join(
    homedir(),
    'Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
)
  .sort()
  .at(-1)
if (!binary) throw Error('没有 Chrome for Testing')
const root = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'litch-files-browser-'))
const server = createServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
await new Promise((r) => server.close(r))
if (port === 9333) throw Error('禁用端口')
const child = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    `--remote-debugging-port=${port}`,
    '--use-mock-keychain',
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1500,1000',
    'about:blank',
  ],
  { env: { HOME: work, PATH: '/usr/bin:/bin', TMPDIR: work }, stdio: 'ignore' },
)
const uiReservation = createServer()
await new Promise((r) => uiReservation.listen(0, '127.0.0.1', r))
const uiPort = uiReservation.address().port
await new Promise((r) => uiReservation.close(r))
const ui = spawn(
  process.execPath,
  [
    join(root, 'packages/ui/node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(uiPort),
    '--strictPort',
  ],
  { cwd: join(root, 'packages/ui'), stdio: 'ignore' },
)
let cdp
try {
  await until(async () => (await fetch(`http://127.0.0.1:${uiPort}/`)).ok, 'Vite')
  const version = await until(
    async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(),
    'ready',
  )
  if (
    execFileSync('/usr/sbin/lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).trim() !== String(child.pid)
  )
    throw Error('PID 不符')
  cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  const target = (await cdp.call('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const read = async (expression) => {
    const result = await cdp.call(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    )
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${uiPort}/?lang=zh-CN` }, sessionId)
  await until(() => read("!!document.querySelector('.sb')"), 'UI')
  async function probe(file, name, ...args) {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [`apps/desktop/src/${file}.mts`],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
    })
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
    await read(
      `window.__probeResult=null; void Promise.resolve((${mod[name].toString()})(${args.map((v) => JSON.stringify(v)).join(',')})).then(value=>window.__probeResult={value},error=>window.__probeResult={error:String(error)})`,
    )
    const value = await until(() => read('window.__probeResult'), name, 60000)
    if (value.error) throw Error(value.error)
    console.log(name, JSON.stringify(value.value).slice(0, 700))
  }
  const home = '核对构建机上的 codex 配置'
  await read(`window.__saves=[];window.__saveActions=[];window.__saveListeners=new Set();window.litchShell={
  saveFile:async request=>{window.__saves.push(request);for(const fn of window.__saveListeners) fn({id:request.id,state:'saving',bytes:2,total:10,destination:'/client/report'});setTimeout(()=>{for(const fn of window.__saveListeners)fn({id:request.id,state:'saved',bytes:10,total:10,destination:'/client/report'})},30)},
  onFileSave:fn=>{window.__saveListeners.add(fn);return()=>window.__saveListeners.delete(fn)},fileSaveAction:async(id,action)=>{window.__saveActions.push(action)},onFileContextMenu:fn=>{window.__frameContext=fn;return()=>{window.__frameContext=null}}
 }`)
  await probe('probe-files-kit', 'installFilesKit')
  await read(`window.__filesKit.openSession(${JSON.stringify(home)})`)
  await read('window.__filesKit.toggle()')
  await until(() => read('window.__filesKit.rows().length > 0'), 'file tree')
  await read(`void window.__filesKit.open('Makefile')`)
  await until(
    () => read(`document.querySelector('.fv-file')?.dataset.state==='ready'`),
    'file ready',
  )
  await read(`window.__filesKit.context(window.__filesKit.row('Makefile'))`)
  assert.equal(await read(`!!document.querySelector('[data-action="saveLocal"]')`), true)
  await read(`document.querySelector('[data-action="saveLocal"]').click()`)
  await until(
    () => read(`document.querySelector('.toast-text')?.textContent.includes('/client/report')`),
    'saved toast',
  )
  assert.equal(await read(`window.__saves[0].path`), '/srv/work/litch/Makefile')
  assert.equal(await read(`window.__saves[0].deviceId`), 'build')
  assert.equal(await read(`window.__saves[0].root`), '/srv/work/litch')
  await read(
    `document.querySelectorAll('.toast-act')[0].click();document.querySelectorAll('.toast-act')[1].click()`,
  )
  assert.deepEqual(await read('window.__saveActions'), ['open', 'reveal'])
  await read(`window.__filesKit.context(window.__filesKit.row('cmd'))`)
  assert.equal(await read(`!!document.querySelector('[data-action="saveLocal"]')`), false)
  await read(
    `window.__filesKit.press(document.querySelector('.pick-pop'),'Escape');window.__filesKit.context(document.querySelector('.fv-file'))`,
  )
  assert.equal(await read(`!!document.querySelector('[data-action="saveLocal"]')`), true)
  await read(`document.querySelector('[data-action="saveLocal"]').click()`)
  assert.equal(await read('window.__saves.length'), 2)
  await read(`document.querySelector('.fv-head [data-tool="save-local"]').click()`)
  assert.equal(await read('window.__saves[2].path'), '/srv/work/litch/Makefile')
  await read(`void window.__filesKit.open('README.md')`)
  await until(
    () =>
      read(
        `document.querySelector('.fv-file')?.dataset.path.endsWith('/README.md') && document.querySelector('.fv-file')?.dataset.state==='ready'`,
      ),
    'markdown preview',
  )
  await read(`window.__filesKit.context(document.querySelector('.fv-file'))`)
  assert.equal(await read(`!!document.querySelector('[data-action="saveLocal"]')`), true)
  await read(`document.querySelector('[data-action="saveLocal"]').click()`)
  assert.equal(await read('window.__saves[3].path'), '/srv/work/litch/README.md')
  console.log('PASS 文件树/预览右键另存、目录排除、来源设备路径、进度结果、打开与显示文件夹')
} finally {
  cdp?.close()
  await Promise.all(
    [child, ui].map(
      (process) =>
        new Promise((resolve) => {
          if (process.exitCode !== null) {
            resolve()
            return
          }
          process.once('exit', resolve)
          process.kill('SIGTERM')
        }),
    ),
  )
  rmSync(work, { recursive: true, force: true })
}
