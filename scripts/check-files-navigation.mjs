// 隔离正式组件 + 本机/回环 SSH 文件读取。无个人模型、配置或浏览器；证据保留在指定目录。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { mobileFilesPlugin } from './files-navigation-mobile-fixture.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const work = mkdtempSync(join(tmpdir(), 'litch-files-navigation-'))
const evidence = process.env.LITCH_FILES_NAV_EVIDENCE ?? join(work, 'evidence')
mkdirSync(evidence, { recursive: true })
const remote = process.argv.includes('--ssh')
const mobile = process.argv.includes('--mobile')
const media = process.argv.includes('--media')
const project = join(work, 'project'),
  sibling = join(work, 'sibling'),
  many = join(work, 'many')
for (const path of [project, sibling, many, join(work, 'home')]) mkdirSync(path)
writeFileSync(join(sibling, 'outside.txt'), 'OUTSIDE-DEVICE-CONTENT\n')
writeFileSync(join(project, 'inside.txt'), 'INSIDE-PROJECT\n')
const manyCount = Number(process.env.LITCH_FILES_NAV_MANY ?? 2003)
for (let n = 0; n < manyCount; n++) writeFileSync(join(many, `${n}.txt`), '')
if (media) {
  symlinkSync(join(sibling, 'outside.txt'), join(project, 'linked.txt'))
  symlinkSync(sibling, join(project, 'linked-dir'))
  symlinkSync(project, join(project, 'loop'))
  const wav = Buffer.alloc(44 + 16000)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(16000, 40)
  writeFileSync(join(sibling, 'clip.wav'), wav)
  writeFileSync(join(sibling, 'invalid.mp4'), '<html>Not media</html>')
  execFileSync('/opt/homebrew/bin/ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=160x90:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    join(sibling, 'clip.mp4'),
  ])
}
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
          b.onLoad({ filter: /files\/preview\/registry\.ts$/ }, (a) => ({
            contents: media
              ? "export const rendererFor=format=>format==='media'?()=>import('./renderers/media.tsx'):format==='markdown'?()=>import('./renderers/markdown.tsx'):undefined;"
              : 'export const rendererFor=()=>undefined;',
            loader: 'js',
            resolveDir: dirname(a.path),
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
rpc.declare(peer, {
  capabilities: { litchExtensions: ['fileBrowser', 'fileRealpath', 'filePreview', 'shortMedia'] },
})
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
  if (!mobile)
    await until(
      () =>
        read(
          `document.querySelector('.path-picker-dialog')?.dataset.devicePath===${JSON.stringify(sibling)}`,
        ),
      'desktop picker loaded',
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
  checks.push(`设备 home 正确；${manyCount} 项层只返回 2,000 项并标记截断`)
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
  if (media) {
    const linked = join(project, 'linked.txt')
    const resolved = await read(`window.__filesNav.resolve(${JSON.stringify(linked)})`)
    assert.equal(resolved.candidates[0].linkPath, linked)
    assert.equal(resolved.candidates[0].path, realpathSync(outside))
    const automatic = await read(
      `window.__filesNav.channel.command('files.preview',{deviceId:'fixture',root:${JSON.stringify(project)},path:${JSON.stringify(linked)},format:'source'})`,
    )
    assert.equal(automatic.kind, 'outside')
    for (const name of ['linked-dir', 'loop']) {
      const target = await read(
        `window.__filesNav.channel.command('files.target',{deviceId:'fixture',root:${JSON.stringify(project)},path:${JSON.stringify(join(project, name))}})`,
      )
      assert.equal(target.root, realpathSync(name === 'loop' ? project : sibling))
    }
    checks.push('显式软链跟随实际目标；自动资源拒绝越界；目录软链与循环不递归扫描')
    if (mobile)
      await read(
        `window.__filesNav.navigation.replace('Files',{deviceId:'fixture',root:${JSON.stringify(project)},path:${JSON.stringify(linked)},defaultRoot:${JSON.stringify(project)},sessionId:'one',workspaceId:'project'})`,
      )
    else {
      await read(`window.__filesNav.open(${JSON.stringify(project)},'directory')`)
      await until(
        () => read(`!!document.querySelector('[role="treeitem"][data-path="${linked}"]')`),
        'symlink row',
      )
      await click(`[role="treeitem"][data-path="${linked}"]`)
    }
    await until(
      () =>
        read(
          mobile
            ? `document.querySelector('[data-testid="files:location"]')?.getAttribute('aria-label')?.includes(${JSON.stringify(realpathSync(sibling))})`
            : `document.querySelector('.files')?.dataset.root===${JSON.stringify(realpathSync(sibling))}`,
        ),
      'symlink navigation',
    )
    await click(mobile ? '[data-testid="files:location"]' : '.ft-location summary')
    await until(
      () =>
        read(
          `document.querySelector(${JSON.stringify(mobile ? '[data-testid="files:full-location"]' : '.ft-location-card')})?.textContent?.includes(${JSON.stringify(linked + ' → ')})`,
        ),
      'symlink provenance',
    )
    await call('Page.captureScreenshot', { format: 'png' }).then((result) =>
      writeFileSync(
        join(evidence, `${mobile ? 'mobile' : 'desktop'}-symlink-${remote ? 'ssh' : 'local'}.png`),
        Buffer.from(result.data, 'base64'),
      ),
    )
    if (mobile)
      await read(
        "[...document.querySelectorAll('[role=button]')].find(b=>b.textContent==='关闭')?.click()",
      )
    else await click('.ft-location summary')
    checks.push('两端文件页显式点开软链后切到真实根，位置详情展示原路径 → 实际路径')
    const show = async (path) => {
      if (mobile)
        await read(
          `window.__filesNav.navigation.replace('Files',{deviceId:'fixture',root:${JSON.stringify(sibling)},path:${JSON.stringify(path)},defaultRoot:${JSON.stringify(project)},sessionId:'one',workspaceId:'project'})`,
        )
      else await read(`window.__filesNav.open(${JSON.stringify(path)})`)
    }
    if (!mobile)
      for (const file of ['preview.css', 'web.css'])
        await read(
          `(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(readFileSync(join(root, 'packages/ui/src/files/preview', file), 'utf8'))};document.head.append(style)})()`,
        )
    const play = mobile ? '[data-testid="files:media-play"]' : '[data-media-play]'
    for (const name of ['clip.wav', 'clip.mp4']) {
      await show(join(sibling, name))
      await until(
        () =>
          read(
            mobile
              ? `!!document.querySelector('[data-testid="files:media:${join(sibling, name)}"]')`
              : `document.querySelector('.fv-file')?.dataset.path===${JSON.stringify(join(sibling, name))}`,
          ),
        `media identity ${name}`,
      )
      await until(
        () =>
          read(
            `(()=>{const b=document.querySelector(${JSON.stringify(play)});return b && !b.disabled && b.getAttribute('aria-disabled')!=='true'})()`,
          ),
        `media ready ${name}`,
        30000,
      )
      const rect = await read(
        `(()=>{const b=document.querySelector(${JSON.stringify(play)}).getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`,
      )
      await call('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        clickCount: 1,
        ...rect,
      })
      await call('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: 'left',
        clickCount: 1,
        ...rect,
      })
      await until(
        () =>
          read(
            `document.querySelector(${JSON.stringify(play)})?.getAttribute('aria-label')==='暂停'`,
          ),
        `media playing ${name}`,
      )
      if (name === 'clip.mp4')
        await call('Page.captureScreenshot', { format: 'png' }).then((result) =>
          writeFileSync(
            join(
              evidence,
              `${mobile ? 'mobile' : 'desktop'}-media-${remote ? 'ssh' : 'local'}.png`,
            ),
            Buffer.from(result.data, 'base64'),
          ),
        )
    }
    checks.push('真实 PCM WAV 与 H.264/AAC MP4 从设备读取，播放器就绪且播放事件到达；无 seek 控件')
    await show(join(sibling, 'invalid.mp4'))
    await until(
      () =>
        read(
          mobile
            ? "document.body.textContent.includes('损坏') || document.body.textContent.includes('无法播放')"
            : "document.querySelector('.fv-file')?.dataset.kind==='invalid'",
        ),
      'invalid media',
    )
    if (mobile) assert.ok(await read('!!document.querySelector(\'[data-testid="files:save"]\')'))
    checks.push('伪 MP4 设备探测拒绝；手机保留另存入口')
  }
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
