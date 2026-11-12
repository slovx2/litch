// 隔离正式组件 + 本机/回环 SSH 文件读取。无个人模型、配置或浏览器；证据保留在指定目录。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { mobileFilesPlugin } from './files-navigation-mobile-fixture.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// macOS 的 Unix socket 路径有长度上限，SSH 夹具还会在此目录下再建入口。
const work = mkdtempSync(
  join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'litch-files-navigation-'),
)
const evidence = process.env.LITCH_FILES_NAV_EVIDENCE ?? join(work, 'evidence')
mkdirSync(evidence, { recursive: true })
const remote = process.argv.includes('--ssh')
const mobile = process.argv.includes('--mobile')
const project = join(work, 'project'),
  sibling = join(work, 'sibling'),
  many = join(work, 'many')
for (const path of [project, sibling, many, join(work, 'home')]) mkdirSync(path)
mkdirSync(join(sibling, 'nested'))
writeFileSync(join(sibling, 'outside.txt'), 'OUTSIDE-DEVICE-CONTENT\n')
writeFileSync(join(project, 'inside.txt'), 'INSIDE-PROJECT\n')
for (let n = 0; n < 2003; n++) writeFileSync(join(many, `${n}.txt`), '')
const bundle = async (entry, name, platform = 'node', extra = {}) => {
  const path = join(work, name)
  await build({
    entryPoints: [join(root, entry)],
    outfile: path,
    bundle: true,
    format: platform === 'node' ? 'esm' : 'iife',
    platform,
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    alias: {
      '@litch/core': join(root, 'packages/core/src/index.mts'),
      react: join(root, 'packages/ui/node_modules/react'),
      'react-dom': join(root, 'packages/ui/node_modules/react-dom'),
    },
    plugins: [
      {
        name: 'fixture-preview-registry',
        setup(b) {
          b.onLoad({ filter: /files\/preview\/registry\.ts$/ }, () => ({
            contents: 'export const rendererFor=()=>undefined;',
            loader: 'js',
          }))
        },
      },
      ...(extra.plugins ?? []),
    ],
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'plugins')),
  })
  return path
}
const backend = await bundle('packages/shared/src/filesystem-rpc.mts', 'rpc.mjs')
const { FilesystemRpc } = await import(backend)
const rpc = new FilesystemRpc(),
  peer = { id: 'fixture', send() {}, close() {} }
rpc.declare(peer, { capabilities: { litchExtensions: ['fileBrowser', 'filePreview'] } })
let sshFixture, sshLink, browser, cdp, vite
const errors = [],
  checks = []
const config = { project, sibling, many, home: join(work, 'home'), remote }
try {
  if (remote) {
    sshFixture = spawn(process.execPath, ['scripts/client-ssh-fixture.mjs'], {
      cwd: root,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: config.home,
        TMPDIR: work,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    sshFixture.stdout.on('data', (data) => {
      log += data
    })
    sshFixture.stderr.on('data', (data) => {
      log += data
    })
    const info = await until(
      () => {
        if (sshFixture.exitCode !== null) throw Error(log)
        const line = log.split('\n').find((line) => line.startsWith('LITCH_SSH_FIXTURE '))
        return line ? JSON.parse(line.slice(18)) : null
      },
      'SSH fixture',
      60000,
    )
    process.env.LITCH_SSH_CONFIG = info.config
    process.env.LITCH_REMOTE_CODEX = info.codex
    process.env.LITCH_REMOTE_ADAPTER = info.adapter
    const driver = join(work, 'ssh.mjs')
    await build({
      stdin: {
        contents: `export{createLink}from'./packages/core/src/index.mts';export{sshOpener}from'./apps/desktop/src/transport-ssh.mts'`,
        resolveDir: root,
      },
      outfile: driver,
      bundle: true,
      platform: 'node',
      format: 'esm',
      banner: {
        js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url)",
      },
    })
    const { createLink, sshOpener } = await import(driver)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('SSH connect timeout')), 60000)
      sshLink = createLink({
        open: sshOpener({ kind: 'alias', alias: info.aliases.svc }),
        clock: {
          now: Date.now,
          setTimer(fn, ms) {
            const id = setTimeout(fn, ms)
            return () => clearTimeout(id)
          },
        },
        clientInfo: { name: 'files-nav-test', title: null, version: 'test' },
        notification() {},
        state(state) {
          if (state.phase === 'connected') {
            clearTimeout(timer)
            resolve()
          } else if (state.phase === 'failed') {
            clearTimeout(timer)
            reject(Error(JSON.stringify(state)))
          }
        },
      })
      sshLink.start()
    })
    const runtime = await sshLink.request('runtime/info', {})
    assert.ok(runtime.device.extensions.includes('fileBrowser'))
    config.home = runtime.device.home
    checks.push('真实 sshOpener → 回环 sshd → 设备聚合 fs；能力已声明')
  }
  writeFileSync(join(config.home, 'nav-home.txt'), 'DEVICE-HOME\n')
  const entry = await bundle('scripts/fixtures/files-navigation.tsx', 'desktop.js', 'browser')
  const mobileEntry = mobile
    ? await bundle('scripts/fixtures/files-navigation-mobile.web.tsx', 'mobile.js', 'browser', {
        plugins: [mobileFilesPlugin(root)],
        define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
        mainFields: ['browser', 'module', 'main'],
        resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
      })
    : null
  const { readFileSync } = await import('node:fs')
  vite = await createServer({
    root: join(root, 'packages/ui'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    logLevel: 'error',
    plugins: [
      {
        name: 'files-navigation-rpc',
        configureServer(server) {
          server.middlewares.use('/files-navigation-rpc', async (req, res) => {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const { method, params } = JSON.parse(Buffer.concat(chunks))
            try {
              res.end(
                JSON.stringify({
                  value: sshLink
                    ? await sshLink.request(method, params)
                    : await rpc.call(peer, method, params),
                }),
              )
            } catch (error) {
              res.end(
                JSON.stringify({
                  error: { code: error.code ?? -32603, message: error.message, data: error.data },
                }),
              )
            }
          })
        },
      },
    ],
  })
  await vite.listen()
  const binary =
    process.env.LITCH_CHROME_BINARY ??
    globSync(
      join(
        homedir(),
        'Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ),
    )
      .sort()
      .at(-1)
  assert.ok(binary)
  browser = spawn(
    binary,
    withChromiumTestArgs([
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${work}/profile`,
      '--window-size=1200,940',
      'about:blank',
    ]),
    { env: { PATH: process.env.PATH, HOME: config.home }, stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let log = ''
  browser.stderr.on('data', (data) => {
    log += data
  })
  cdp = await Cdp.connect(
    await until(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], 'CDP'),
  )
  const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, params) => cdp.call(method, params, sessionId)
  const read = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails)
      throw Error(
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails),
      )
    return result.result.value
  }
  cdp.listeners.add((event) => {
    if (event.sessionId === sessionId && event.method === 'Runtime.exceptionThrown') {
      errors.push(event.params.exceptionDetails)
      console.error(JSON.stringify(event.params.exceptionDetails))
    }
  })
  await call('Runtime.enable')
  await call('Page.navigate', {
    url: `http://127.0.0.1:${vite.httpServer.address().port}/?lang=zh-CN`,
  })
  await until(() => read("!!window.__litchLook && !!document.querySelector('.sb')"), 'app')
  await read('window.__litchLook.set({skin:"standard",theme:"light",lang:"zh-CN"})')
  await read(`window.__filesConfig=${JSON.stringify(config)}`)
  await read(readFileSync(entry, 'utf8'))
  await until(() => read("document.querySelector('.files')?.dataset.root"), 'desktop fixture')
  if (mobileEntry) {
    await read(readFileSync(mobileEntry, 'utf8'))
    await until(
      () => read('!!document.querySelector(\'[data-testid="files:list"]\')'),
      'mobile fixture',
    )
  }
  const selector = (name) =>
    mobile ? `[data-testid="files:${name}"]` : `[data-files-nav="${name}"]`
  const current = () =>
    read(
      mobile
        ? 'window.__filesNav.stack.at(-1).root'
        : "document.querySelector('.files')?.dataset.root",
    )
  const click = (css) => read(`document.querySelector(${JSON.stringify(css)})?.click()`)
  await click(selector('up'))
  await until(async () => (await current()) === work, 'parent')
  if (mobile) assert.equal(await read('window.__filesNav.stack.length'), 1)
  else {
    await read("window.__filesNav.session('two')")
    await until(async () => (await current()) === project, 'session two')
    await read("window.__filesNav.session('one')")
    await until(async () => (await current()) === work, 'session one')
  }
  checks.push('上一级只改浏览根；会话隔离；手机换根栈深保持 1')
  await click(selector('project'))
  await until(async () => (await current()) === project, 'back project')
  const picked = mobile ? '[data-testid="path-picker:directory"]' : '[data-path-picker="directory"]'
  await click(picked)
  const input = mobile ? '[data-testid="path-picker:path"]' : '.path-picker-location input'
  await until(() => read(`!!document.querySelector(${JSON.stringify(input)})`), 'picker')
  await read(
    `(()=>{const input=document.querySelector(${JSON.stringify(input)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(sibling)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  )
  if (mobile)
    await read(
      "[...document.querySelectorAll('[role=button]')].find(b=>b.textContent==='前往')?.click()",
    )
  else await read("document.querySelector('.path-picker-location').requestSubmit()")
  await until(
    () =>
      read(`document.querySelector(${JSON.stringify(input)})?.value===${JSON.stringify(sibling)}`),
    'picker input',
  )
  if (mobile)
    await until(
      () => read(`!!document.querySelector('[data-testid="path-picker:listing:${sibling}"]')`),
      'picker loaded',
    )
  // 输入框先更新；目录回包后选择按钮才可用，不能把草稿值当成加载完成。
  else
    await until(
      () =>
        read(
          "!!document.querySelector('.path-picker-entries')?.textContent.includes('nested/') && document.querySelector('.path-picker-dialog .primary')?.disabled===false",
        ),
      'picker loaded',
    )
  await read(
    mobile
      ? "[...document.querySelectorAll('[role=button]')].find(b=>b.dataset.testid==='path-picker:select')?.click()"
      : "document.querySelector('.path-picker-dialog .primary')?.click()",
  )
  await until(async () => (await current()) === sibling, 'picked root')
  const outside = join(sibling, 'outside.txt')
  if (mobile)
    await until(
      () => read('!!document.querySelector(\'[data-testid="file:outside.txt"]\')'),
      'outside row',
    )
  await click(
    mobile ? '[data-testid="file:outside.txt"]' : `[role="treeitem"][data-path="${outside}"]`,
  )
  await until(
    () => read("document.body.textContent.includes('OUTSIDE-DEVICE-CONTENT')"),
    'outside contents',
  )
  checks.push('打开任意设备目录 → 读取同级文本，内容来自设备 fs')
  const home = await read(
    "window.__filesNav.channel.command('folders.list',{deviceId:'fixture',path:'~'}).then(x=>x.path)",
  )
  assert.equal(home, config.home)
  const listing = await read(
    `window.__filesNav.channel.command('files.list',{deviceId:'fixture',root:${JSON.stringify(many)},path:${JSON.stringify(many)}})`,
  )
  assert.equal(listing.entries.length, 2000)
  assert.equal(listing.truncated, true)
  checks.push('设备 home 正确；2,003 项层只返回 2,000 项并标记截断')
  const height = await read(
    `document.querySelector(${JSON.stringify(mobile ? '[data-testid="files:navigation"]' : '.ft-navigation')}).getBoundingClientRect().height`,
  )
  assert.ok(height <= (mobile ? 45 : 34), `导航不应增加多行高度：${height}`)
  await click(mobile ? '[data-testid="files:location"]' : '.ft-location summary')
  await until(
    () =>
      read(
        mobile
          ? `document.querySelector('[data-testid="files:full-location"]')?.textContent===${JSON.stringify(sibling)}`
          : "!!document.querySelector('.ft-location[open]')",
      ),
    'full location',
  )
  await click(mobile ? '[role="button"][aria-label="关闭"]' : '.ft-location summary')
  if (mobile)
    await read(
      "[...document.querySelectorAll('[role=button]')].find(b=>b.textContent==='关闭')?.click()",
    )
  checks.push(`图标导航保持单行（${height}px），点路径可查看完整设备位置`)
  await call('Page.captureScreenshot', { format: 'png' }).then((result) =>
    writeFileSync(
      join(evidence, `${mobile ? 'mobile' : 'desktop'}-${remote ? 'ssh' : 'local'}.png`),
      Buffer.from(result.data, 'base64'),
    ),
  )
  assert.deepEqual(errors, [])
  writeFileSync(
    join(evidence, `${mobile ? 'mobile' : 'desktop'}-${remote ? 'ssh' : 'local'}.json`),
    JSON.stringify({ checks, errors, config, seen: await read('window.__filesNav.seen') }, null, 2),
  )
  console.log(JSON.stringify({ evidence, checks, errors }))
} finally {
  cdp?.close()
  browser?.kill()
  await vite?.close()
  rpc.close()
  sshLink?.stop()
  sshFixture?.kill('SIGTERM')
}
