// 正式桌面侧栏 + 模拟核心；拖放与菜单走真实组件，隔离 CFT，不使用用户浏览器。
// 先 npm run dev --prefix packages/ui -- --port 5299，再 node scripts/check-local-workspace-ui.mjs。
// 手机先 npm run preview --prefix apps/mobile -- --port 5289，再加 --mobile。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { verifyPinnedRecent } from './check-local-workspace-recent.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const mobile = process.argv.includes('--mobile')
const recent = process.argv.includes('--recent')
const base = process.env.LITCH_LOCAL_WORKSPACE_UI ?? `http://127.0.0.1:${mobile ? 5289 : 5299}`
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('只接受回环夹具')
const output = resolve(
  process.env.LITCH_LOCAL_WORKSPACE_OUTPUT ?? '../.local/local-group-workspace',
)
mkdirSync(output, { recursive: true })
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
if (!binary?.includes('for Testing')) throw new Error('需要隔离 Chrome for Testing')
const work = mkdtempSync(join(tmpdir(), 'litch-local-workspace-'))
const child = spawn(
  binary,
  withChromiumTestArgs([
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--window-size=1360,1000',
    'about:blank',
  ]),
  {
    env: { PATH: process.env.PATH, HOME: work, CODEX_HOME: join(work, 'codex'), TMPDIR: work },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
const exited = new Promise((done) => child.once('exit', done))
let stderr = ''
child.stderr.on('data', (data) => {
  stderr += data
})
let cdp
let inspectFailure
const report = { success: false, mobile, checks: [], errors: [] }
try {
  const endpoint = await until(
    () => stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1],
    '浏览器',
  )
  cdp = await Cdp.connect(endpoint)
  const target = (await cdp.call('Target.getTargets')).targetInfos.find(
    (entry) => entry.type === 'page',
  )
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const call = (method, params = {}) => cdp.call(method, params, sessionId)
  cdp.listeners.add((event) => {
    if (event.method === 'Runtime.exceptionThrown')
      report.errors.push(
        event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text,
      )
  })
  await call('Runtime.enable')
  const read = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      )
    return result.result.value
  }
  const run = (fn, ...args) => read(`(${fn.toString()})(...${JSON.stringify(args)})`)
  const exists = (selector) => run((s) => !!document.querySelector(s), selector)
  const click = async (selector) => {
    await until(() => exists(selector), selector)
    await run((s) => {
      const el = document.querySelector(s)
      el.scrollIntoView({ block: 'nearest' })
      el.click()
    }, selector)
  }
  const shot = async (name) => {
    await read('document.fonts.ready')
    await read('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
    const image = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, name), Buffer.from(image.data, 'base64'))
  }
  inspectFailure = async () => {
    report.page = await read(
      '({ url: location.href, text: document.body.innerText.slice(0, 6000) })',
    )
    await shot(mobile ? 'mobile-failure.png' : 'desktop-failure.png')
  }
  if (recent) {
    await verifyPinnedRecent({ call, base, run, click, exists, shot, until })
    report.checks.push(
      '查看置顶会话后进入最近；置顶项目内的会话也进入最近，未读仍排除，每个主项只有一行',
    )
  } else if (mobile) {
    await call('Emulation.setDeviceMetricsOverride', {
      width: 430,
      height: 932,
      deviceScaleFactor: 1,
      mobile: true,
    })
    await call('Page.navigate', { url: `${base}/?app=1&scene=local-workspace` })
    await until(() => exists('[data-testid="device:local"]'), '手机首页', 60000)
    const before = await read('window.__localOrganizerFiles()')
    const file = JSON.parse(before[0])
    assert.equal(file.version, 2)
    assert.equal(file.groups[0].members[0].kind, 'workspace')
    assert.equal(await exists('[data-testid="localGroups"]'), false)
    assert.equal(await exists('[data-testid="pins"]'), false)
    await click('[data-testid="device:local"]')
    await until(() => exists('[data-testid="sessions"]'), '手机设备目录')
    assert.deepEqual(await read('window.__localOrganizerFiles()'), before)
    await shot('mobile-local-workspace.png')
    report.checks.push('含项目成员的 v2 文件正常启动与打开设备目录；隐藏入口未恢复，文件原文未改变')
  } else {
    await call('Page.navigate', { url: `${base}/test/local-workspace-fixture.html?lang=zh-CN` })
    await until(() => exists('[data-local-group="one"]'), '桌面本机组', 60000)
    const state = () => read('window.__localWorkspace.organizer.load().file')
    const command = (name, params) =>
      run((n, p) => window.__localWorkspace.channel.command(n, p), name, params)
    const one = '[data-local-group="one"]'
    const two = '[data-local-group="two"]'
    const pins = '[data-shortcuts="pins"]'
    const project = '[data-workspace="litch"]'
    const docs = '[data-workspace="docs"]'
    await command('workspace.update', { deviceId: 'local', workspaceId: 'litch', pinned: true })
    await until(() => exists(`${pins} ${project}`), '置顶项目')
    const drag = async (source, target, after = false) => {
      await until(() => exists(source), `拖动来源 ${source}`)
      await until(() => exists(target), `拖动落点 ${target}`)
      const result = await run(
        (src, dst, lower) => {
          const sourceEl = document.querySelector(src)
          const targetEl = document.querySelector(dst)
          const transfer = new DataTransfer()
          sourceEl.dispatchEvent(
            new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }),
          )
          const rect = targetEl.getBoundingClientRect()
          const init = {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
            clientY: rect.top + rect.height * (lower ? 0.8 : 0.2),
          }
          const accepted = !targetEl.dispatchEvent(new DragEvent('dragover', init))
          targetEl.dispatchEvent(new DragEvent('drop', init))
          sourceEl.dispatchEvent(
            new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }),
          )
          return accepted
        },
        source,
        target,
        after,
      )
      assert.equal(result, true, '拖放应接住项目')
    }
    await drag(`${pins} ${project}`, `${one} .sc-head`)
    await until(
      async () =>
        (await state()).groups[0].members.some(
          (ref) => ref.kind === 'workspace' && ref.workspaceId === 'litch',
        ),
      '置顶项目引用保存',
    )
    assert.equal(await exists(`${one} ${project}`), false)
    assert.ok(await exists(`${pins} ${project}`))
    await until(() => exists(`${one} .sc-note`), '置顶成员计数')
    await until(
      () => run(() => document.body.innerText.includes('该成员仍显示在置顶区')),
      '保留置顶提示',
    )
    report.checks.push('置顶项目拖入组保留引用和置顶，仅显示计数与提示')
    const menu = async (row) => {
      await until(() => exists(row), `菜单来源 ${row}`)
      await run(
        (selector) =>
          document
            .querySelector(selector)
            .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
        row,
      )
      await until(() => exists('[data-action="local"]'), '项目右键本机菜单')
    }
    await menu(`${pins} ${project}`)
    await click('[data-action="pin"]')
    await until(() => exists(`${one} ${project}`), '取消置顶回到原位')
    assert.equal(await exists(`${pins} ${project}`), false)
    assert.equal((await state()).groups[0].members[0].workspaceId, 'litch')
    await menu(`.dev-group ${docs}`)
    await click('[data-action="local"]')
    await click('[data-choice="two"]')
    await until(() => exists(`${two} ${docs}`), '菜单加入项目')
    await drag(`${two} ${docs}`, `${one} .sc-head`)
    await until(async () => (await state()).groups[1].members.length === 0, '跨组移动')
    await drag(`${one} ${docs}`, `${one} .sc-item`)
    await until(
      async () => (await state()).groups[0].members[0].workspaceId === 'docs',
      '组内项目排序',
    )
    await menu(`${one} ${docs}`)
    await click('[data-action="unlocal"]')
    await until(() => run((s) => !document.querySelector(s), `${one} ${docs}`), '菜单移出项目')
    report.checks.push('菜单加入、跨组拖放、组内排序、菜单移出；取消置顶回原位')
    await command('organizer.apply', {
      action: {
        type: 'member.add',
        groupId: 'one',
        member: { kind: 'session', deviceId: 'local', sessionId: 's2' },
      },
    })
    await click(`${one} ${project} .head-toggle`)
    await until(() => exists(`${one} [data-session="s1"]`), '项目展开')
    assert.equal(
      await run((s) => document.querySelectorAll(s).length, `${one} [data-session="s2"]`),
      1,
    )
    await run(() => {
      const { store, keys, commands } = window.__localWorkspace
      const key = keys.device('local')
      store.set(key, { ...store.get(key), connection: 'offline', organizable: false })
      commands.length = 0
    })
    await menu(`${one} ${project}`)
    assert.equal(await exists('[data-action="edit"]'), false)
    await click('[data-action="local"]')
    await click('[data-choice="two"]')
    await until(() => exists(`${two} ${project}`), '离线项目可加入另一组')
    assert.deepEqual(await read('window.__localWorkspace.commands.map(c=>c.name)'), [
      'organizer.apply',
    ])
    report.checks.push('离线整理只发本机命令；项目与显式会话仅画一行')
    await menu(`${two} ${project}`)
    await click('[data-action="local"]')
    await click('[data-choice=":new"]')
    await run(() => {
      const input = document.querySelector('#local-group-name')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
        input,
        '离线新组',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('dialog .btn.primary')
    await until(async () => (await state()).groups.length === 3, '离线新建组并加入项目')
    report.checks.push('离线菜单新建组并加入项目')
    for (const skin of ['retro', 'human', 'standard']) {
      for (const lang of ['zh-CN', 'en']) {
        await run((look) => window.__litchLook.set(look), { skin, theme: 'light', lang })
        await run(() => {
          document.querySelector('.sb-scroll').scrollTop = 0
        })
        await shot(`desktop-${skin}-${lang}.png`)
      }
    }
  }
  assert.deepEqual(report.errors, [])
  report.success = true
} catch (error) {
  await inspectFailure?.()
  report.failure = error.stack
  throw error
} finally {
  writeFileSync(
    join(
      output,
      mobile ? 'mobile-report.json' : recent ? 'recent-report.json' : 'desktop-report.json',
    ),
    JSON.stringify(report, null, 2),
  )
  cdp?.close()
  child.kill('SIGTERM')
  await exited
  console.log(JSON.stringify(report, null, 2))
}
