// 侧栏投影验收。自动启动回环 Vite，只控制自己创建的 headless CFT。
// 用法：node scripts/check-sidebar-projections.mjs；也可用 LITCH_PROJECTIONS_UI 指向已启动的回环夹具。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Cdp, until } from './chrome-m0/cdp.mjs'

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
let base = process.env.LITCH_PROJECTIONS_UI
if (base && !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('只接受回环夹具')
const work = mkdtempSync(join(tmpdir(), 'litch-projections-ui-'))
const outputBase = resolve('.local/sidebar-projections')
const output = join(outputBase, `${Date.now()}-${process.pid}`)
mkdirSync(output, { recursive: true })
const report = { checks: [], success: false, work, output }
let vite
if (!base) {
  const reserve = createServer()
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve))
  const port = reserve.address().port
  await new Promise((resolve) => reserve.close(resolve))
  base = `http://127.0.0.1:${port}`
  vite = spawn(
    process.execPath,
    [
      resolve('packages/ui/node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: resolve('packages/ui'),
      env: { PATH: process.env.PATH, HOME: work, CODEX_HOME: join(work, 'codex') },
      stdio: 'ignore',
    },
  )
}
const child = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-background-networking',
    '--window-size=1200,900',
    'about:blank',
  ],
  {
    env: { PATH: process.env.PATH, HOME: work, CODEX_HOME: join(work, 'codex'), TMPDIR: work },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
let cdp
let log = ''
child.stderr.on('data', (data) => {
  log += data.toString()
})
try {
  await until(async () => (await fetch(`${base}/`)).ok, '回环界面服务')
  const port = await until(
    () => Number(readFileSync(join(work, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0]),
    '浏览器端口',
  )
  assert.ok(
    execFileSync('ps', ['-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' }).includes(
      `${work}/profile`,
    ),
  )
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  cdp = await Cdp.connect(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await cdp.call('Runtime.enable')
  await cdp.call('Page.enable')
  // 隔离的无头页面模拟前台窗口，不激活用户的浏览器。
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  const errors = []
  cdp.listeners.add((message) => {
    if (message.method === 'Runtime.exceptionThrown')
      errors.push(
        message.params.exceptionDetails.text +
          ': ' +
          message.params.exceptionDetails.exception?.description,
      )
  })
  const evaluate = async (expression) => {
    const r = await cdp.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  const run = (fn, ...args) => evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`)
  const click = async (selector) => {
    await until(() => run((s) => !!document.querySelector(s), selector), selector)
    await run((s) => document.querySelector(s).click(), selector)
  }
  const option = async (text) => {
    await until(
      () =>
        run(
          (t) =>
            [...document.querySelectorAll('.pick-pop button')].some(
              (e) => e.textContent.trim() === t,
            ),
          text,
        ),
      text,
    )
    await run(
      (t) =>
        [...document.querySelectorAll('.pick-pop button')]
          .find((e) => e.textContent.trim() === t)
          .click(),
      text,
    )
  }
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', {
    source:
      '(' +
      (() => {
        if (localStorage.getItem('projection-seeded')) return
        const rows = [
          'cd1',
          's3',
          's7',
          's4',
          's5',
          's6',
          's8',
          's9',
          'd1',
          'd2',
          'd3',
          'd4',
          'd5',
          'd6',
          'd7',
          'd8',
          'd9',
          'p1',
          'p2',
        ].map((sessionId, i) => ({
          deviceId: 'local',
          sessionId,
          at: Date.now() - 10000 - i * 1000,
        }))
        rows.push(
          { deviceId: 'build', sessionId: 'b3', at: Date.now() - 12000 },
          { deviceId: 'gpu', sessionId: 'g1', at: Date.now() - 13000 },
        )
        localStorage.setItem('litch.sidebar.activity', JSON.stringify(rows))
        localStorage.setItem('projection-seeded', '1')
        localStorage.setItem('litch.onboarding', 'done')
      }).toString() +
      ')()',
  })
  await cdp.call('Page.navigate', { url: `${base}/` })
  await until(
    () => run(() => document.querySelectorAll('[data-projection]').length === 2),
    '两个投影组',
  )
  await run(() => document.querySelector('[data-act=onboard-close]')?.click())
  await run(() => window.__litchLook.set({ skin: 'standard', theme: 'light', lang: 'zh-CN' }))
  const recent = '[data-projection=recent]'
  const unread = '[data-projection=unread]'
  const roots = () =>
    run(() =>
      [
        ...document.querySelectorAll('[data-projection=recent] [data-depth="0"] > [data-session]'),
      ].map((e) => e.dataset.session),
    )
  await until(async () => (await roots()).length === 5, '默认五个主项')
  assert.equal((await roots())[0], 's1', '子会话归并到主会话')
  assert.equal(
    await run(() => !!document.querySelector('[data-projection=recent] [data-session=cd1]')),
    false,
  )
  await click(`${recent} [data-session=s1] .tree-fold`)
  await until(
    () => run(() => !!document.querySelector('[data-projection=recent] [data-session=cd1]')),
    '展开原生子会话',
  )
  await click(`${recent} [data-session=s1] .tree-fold`)
  await click(`${recent} .ss-more .more`)
  await until(async () => (await roots()).length === 15, '增加十个主项')
  report.checks.push('主项归并、默认五项、展开子树、更多增加十项')
  assert.equal(
    await run(
      () => document.querySelectorAll('[data-projection=unread] .projection-device').length,
    ),
    0,
    '本机投影不显示设备名',
  )
  assert.ok(
    await run(() =>
      [...document.querySelectorAll('[data-projection=recent] [data-depth="0"] .ss-row')].every(
        (row) =>
          !!row.querySelector('.projection-device') ===
          (row.closest('[data-device]')?.dataset.device !== 'local'),
      ),
    ),
    '平铺行只显示远程设备名，本机行省略',
  )
  assert.equal(
    await run(() => !!document.querySelector('[data-projection=recent] .projection-count')),
    false,
  )
  assert.ok(
    await run(() =>
      document.querySelector('[data-projection=unread] .time').title.startsWith('最近新结果：'),
    ),
  )
  assert.ok(
    await run(() =>
      document.querySelector('[data-projection=recent] .time').title.startsWith('最近查看或操作：'),
    ),
  )
  const beforeRead = await run(() => {
    const box = document
      .querySelector('[data-projection=unread] [data-session=s3] .ss-row')
      .getBoundingClientRect()
    return { x: box.x + 70, y: box.y + box.height / 2 }
  })
  await click(`${unread} [data-session=s3] .ss-row`)
  await until(
    () =>
      run(
        () =>
          !!document.querySelector(
            '[data-projection=unread] [data-session=s3] .ss-row.sel:not(.is-unread)',
          ),
      ),
    '查看清未读后原位保留已读行',
  )
  assert.equal(
    await run(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-session]')?.dataset.session,
      beforeRead,
    ),
    's3',
  )
  assert.equal(
    await run(
      () => !!document.querySelector('[data-projection=unread] [data-session=s3] .st.unread'),
    ),
    false,
  )
  const selectedCopies = await run(() => ({
    tree: [...document.querySelectorAll('.ss-row:not(.projection-group *).sel')].map(
      (row) => row.closest('[data-session]').dataset.session,
    ),
    projections: [...document.querySelectorAll('.projection-group .ss-row.sel')].map(
      (row) => row.closest('[data-session]').dataset.session,
    ),
    unreadCount: Number(
      document.querySelector('[data-projection=unread] .projection-count').textContent,
    ),
    unreadRows: document.querySelectorAll('[data-projection=unread] .ss-row.is-unread').length,
  }))
  assert.deepEqual(selectedCopies.tree, ['s3'], '目录只保留一条选中会话')
  assert.ok(selectedCopies.projections.length >= 2, '同一会话同时出现在最近、原位保留的未读组')
  assert.ok(
    selectedCopies.projections.every((id) => id === 's3'),
    '投影选中态与目录一致',
  )
  assert.equal(
    selectedCopies.unreadCount,
    selectedCopies.unreadRows,
    '未读计数不包含已读的原位保留副本',
  )
  report.checks.push('投影副本选中态一致，目录查询不重复，未读计数不受副本影响')
  assert.equal(
    await run(
      () =>
        getComputedStyle(
          document.querySelector('[data-projection=unread] [data-session=s3] .title'),
        ).fontWeight,
    ),
    '400',
  )
  for (const clickCount of [1, 2]) {
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...beforeRead,
      button: 'left',
      clickCount,
    })
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...beforeRead,
      button: 'left',
      clickCount,
    })
  }
  assert.ok(
    await run(() => !!document.querySelector('[data-projection=unread] [data-session=s3] .sel')),
  )
  const heldShot = await cdp.call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(
    join(output, 'unread-held-after-double-click.png'),
    Buffer.from(heldShot.data, 'base64'),
  )
  await click(`${recent} [data-session=s4] .ss-row`)
  await until(
    () => run(() => !document.querySelector('[data-projection=unread] [data-session=s3]')),
    '切走移除已读暂留项',
  )
  await click(`${recent} [data-session=s3] .ss-row`)
  assert.equal(
    await run(() => !!document.querySelector('[data-projection=unread] [data-session=s3]')),
    false,
    '重新打开已读项不重新放进未读',
  )
  assert.notEqual((await roots())[0], 's3', '短暂打开和清未读不应刷新最近排序')
  assert.ok(await run(() => document.hasFocus() && document.visibilityState === 'visible'))
  report.checks.push(
    '未读原位暂留、已读样式、鼠标连点不串项、切走移除、已读不回填、设备名与时间口径',
  )
  const dwellStarted = await run(() => Date.now())
  await until(async () => (await roots())[0] === 's3', '连续前台停留满五秒更新最近排序')
  // 稍早的查看已切走清零；此时的时间戳来自本次达标，而不是初次点开。
  await until(
    () =>
      run(
        (since) =>
          JSON.parse(localStorage.getItem('litch.sidebar.activity')).some(
            (row) => row.deviceId === 'local' && row.sessionId === 's3' && row.at >= since,
          ),
        dwellStarted,
      ),
    '达标时刻持久化',
  )
  report.checks.push('打开立即清未读、短暂查看不刷新最近、连续前台五秒后记录达标时刻')
  await click(`${recent} .projection-head .dev-row`)
  assert.equal(
    await run(() => !!document.querySelector('[data-projection=recent] .projection-body')),
    false,
  )
  assert.equal(
    await run(() => !!document.querySelector('[data-projection=unread] .projection-body')),
    true,
  )
  await click(`${recent} .projection-head .dev-row`)
  await click(`${recent} .projection-head .row-more button`)
  assert.equal(
    await run(() => document.querySelector('[data-action=project]').getAttribute('aria-checked')),
    'false',
  )
  assert.equal(
    await run(() => document.querySelector('[data-action=project]').getAttribute('role')),
    'menuitemcheckbox',
  )
  await option('按项目聚合')
  await until(
    () => run(() => !!document.querySelector('[data-projection=recent] [data-workspace=litch]')),
    '项目聚合',
  )
  assert.ok(
    await run(() =>
      [...document.querySelectorAll('[data-projection=recent] [data-workspace]')].every(
        (head) => !!head.querySelector('.projection-device.project'),
      ),
    ),
  )
  assert.equal(
    await run(() => !!document.querySelector('[data-projection=recent] .projection-block[title]')),
    false,
  )
  await click(`${recent} .projection-head .row-more button`)
  assert.equal(
    await run(() => document.querySelector('[data-action=project]').getAttribute('aria-checked')),
    'true',
  )
  assert.ok(await run(() => !!document.querySelector('[data-action=project] svg')))
  await click(`${recent} .projection-head .row-more button`)
  const colors = await run(() =>
    [...document.querySelectorAll('[data-projection=recent] .projection-block')].map((b) => {
      const d = document.querySelector(`.dev-group[data-device=${b.dataset.device}]`)
      return {
        device: b.dataset.device,
        color: getComputedStyle(b).getPropertyValue('--wire'),
        original: d && getComputedStyle(d).getPropertyValue('--wire'),
      }
    }),
  )
  assert.ok(
    colors.every((row) => row.color === row.original),
    '设备色一致',
  )
  assert.ok(
    await run(
      () =>
        !!document.querySelector('[data-projection=recent] .projection-block.off[data-device=gpu]'),
    ),
  )
  report.checks.push('查看清未读并更新最近、独立折叠、跨设备项目聚合、离线缓存、设备色一致')
  await click(`${recent} [data-workspace=litch] .row-more button`)
  await option('重命名与颜色…')
  await until(() => run(() => !!document.querySelector('.ws-dialog[open]')), '原项目编辑对话框')
  await run(() => {
    const input = document.querySelector('.ws-dialog input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
      input,
      '投影验收项目',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('.ws-dialog button[type=submit]')
  await until(
    () =>
      run(
        () =>
          document.querySelector('.dev-group[data-device=local] [data-workspace=litch] .name')
            ?.textContent === '投影验收项目',
      ),
    '项目操作同步原树',
  )
  await click(`${recent} [data-workspace=litch] .row-add`)
  await until(() => run(() => !document.querySelector('.tr-scroll')), '项目新建对话入口')
  report.checks.push('投影项目可改名并同步原树、新建对话入口')
  await click(`${recent} .projection-head .row-more button`)
  await option('默认显示 5 条')
  assert.equal(
    await run(() => document.querySelector('[data-choice="5"]').getAttribute('role')),
    'menuitemradio',
  )
  assert.equal(
    await run(() => document.querySelector('[data-choice="5"]').getAttribute('aria-checked')),
    'true',
  )
  assert.ok(await run(() => !!document.querySelector('[data-choice="5"] svg')))
  await option('10')
  await until(async () => (await roots()).length === 10, '默认条数设置')
  await click(`${unread} .projection-head .dev-row`)
  await cdp.call('Page.reload')
  await until(
    () => run(() => !!document.querySelector('[data-projection=recent] [data-workspace=litch]')),
    '重启恢复项目聚合',
  )
  await until(async () => (await roots()).length === 10, '重启恢复默认条数')
  await click(`${recent} .projection-head .row-more button`)
  await option('默认显示 10 条')
  assert.equal(
    await run(() => document.querySelector('[data-choice="10"]').getAttribute('aria-checked')),
    'true',
  )
  assert.equal(
    await run(() => document.querySelector('[data-choice="5"]').getAttribute('aria-checked')),
    'false',
  )
  await click(`${recent} .projection-head .row-more button`)
  assert.equal(
    await run(() => !!document.querySelector('[data-projection=unread] .projection-body')),
    false,
  )
  assert.equal((await roots())[0], 's3')
  report.checks.push('浏览记录、聚合、默认条数和折叠本机持久化')
  await click(`${unread} .projection-head .dev-row`)
  await click('[data-sidebar-mode=manager]')
  await until(
    () => run(() => document.querySelectorAll('[data-projection]').length === 0),
    '经理视图不显示投影',
  )
  await click('[data-sidebar-mode=chat]')
  await until(
    () => run(() => document.querySelectorAll('[data-projection]').length === 2),
    '返回对话投影',
  )
  await run(() => import('/src/sidebar/state.ts').then((m) => m.setSidebarWidth(240)))
  const accessibility = await cdp.call('Accessibility.getFullAXTree')
  assert.ok(
    accessibility.nodes.some(
      (node) => node.role?.value === 'region' && node.name?.value === '未读',
    ),
  )
  assert.ok(
    accessibility.nodes.some(
      (node) => node.role?.value === 'region' && node.name?.value === '最近',
    ),
  )
  assert.ok(
    accessibility.nodes.some(
      (node) => node.role?.value === 'button' && node.name?.value.includes('个未读对话'),
    ),
  )
  report.checks.push('可访问命名分组、带单位的未读计数、最近无总数、菜单勾选及 radio/checkbox 状态')
  await click(`${unread} [data-session=s3] .ss-row`)
  await until(
    () =>
      run(
        () =>
          !!document.querySelector(
            '[data-projection=unread] [data-session=s3] .sel:not(.is-unread)',
          ),
      ),
    '六套皮肤的已读暂留样式',
  )
  for (const skin of ['standard', 'human', 'retro']) {
    for (const theme of ['light', 'dark']) {
      await run((skin, theme) => window.__litchLook.set({ skin, theme }), skin, theme)
      await run(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      const geometry = await run(() => ({
        width: document.querySelector('.sb').getBoundingClientRect().width,
        overflow: [...document.querySelectorAll('.projection-body')].some(
          (e) => e.scrollWidth > e.clientWidth + 1,
        ),
      }))
      assert.equal(geometry.width, 240)
      assert.equal(geometry.overflow, false)
      const alignment = await run(() => ({
        group: document.querySelector('.projection-head .name').getBoundingClientRect().x,
        device: document.querySelector('.dev-group .dev-row .name').getBoundingClientRect().x,
      }))
      assert.ok(Math.abs(alignment.group - alignment.device) < 1, '投影组头与设备名对齐')
      assert.equal(
        await run(
          () =>
            getComputedStyle(
              document.querySelector('[data-projection=unread] [data-session=s3] .title'),
            ).fontWeight,
        ),
        '400',
      )
      const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(output, `${skin}-${theme}-240.png`), Buffer.from(shot.data, 'base64'))
      report.checks.push({ skin, theme, ...geometry })
      await click(`${recent} .projection-head .row-more button`)
      await option('按项目聚合')
      await until(
        () => run(() => !document.querySelector('[data-projection=recent] [data-workspace]')),
        '取消聚合检查平铺设备名',
      )
      assert.ok(
        await run(() =>
          [...document.querySelectorAll('[data-projection=recent] .projection-device')].every(
            (name) => name.scrollWidth <= name.clientWidth + 1,
          ),
        ),
        '窄侧栏中的常见设备名完整可读',
      )
      assert.ok(
        await run(() =>
          [...document.querySelectorAll('[data-projection=recent] [data-depth="0"] .ss-row')].every(
            (row) =>
              !!row.querySelector('.projection-device') ===
              (row.closest('[data-device]')?.dataset.device !== 'local'),
          ),
        ),
      )
      assert.equal(
        await run(() =>
          [...document.querySelectorAll('.projection-body')].some(
            (e) => e.scrollWidth > e.clientWidth + 1,
          ),
        ),
        false,
      )
      const flatShot = await cdp.call('Page.captureScreenshot', { format: 'png' })
      writeFileSync(
        join(output, `${skin}-${theme}-flat-240.png`),
        Buffer.from(flatShot.data, 'base64'),
      )
      await click(`${recent} .projection-head .row-more button`)
      await option('按项目聚合')
    }
  }
  assert.deepEqual(errors, [])
  report.success = true
} catch (error) {
  report.failure = String(error?.stack ?? error)
  if (cdp) {
    report.debug = await cdp.call('Runtime.evaluate', {
      expression:
        'JSON.stringify({storage:{...localStorage},rows:[...document.querySelectorAll("[data-projection=recent] [data-session]")].map(e=>e.dataset.session)})',
      returnByValue: true,
    })
    const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, 'failure.png'), Buffer.from(shot.data, 'base64'))
  }
  throw error
} finally {
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(outputBase, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(output, 'browser.log'), log)
  cdp?.close()
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
  vite?.kill('SIGTERM')
}
console.log(JSON.stringify(report, null, 2))
