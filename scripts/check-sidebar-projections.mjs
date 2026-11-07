// 侧栏投影验收。自动启动回环 Vite，只控制自己创建的 headless CFT。
// 不进 Full/check:nightly。改动侧栏、会话树、未读、运行中标识、置顶分组或设备色块后，
// 在本地运行 npm run client:check:projections；准备方式见 docs/reference/ci-flaky.md。
// 用法：node scripts/check-sidebar-projections.mjs；也可用 LITCH_PROJECTIONS_UI 指向已启动的回环夹具。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { diagnoseFailure } from './chrome-m0/diagnostics.mjs'

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
const outputBase = process.env.LITCH_PROJECTIONS_OUTPUT
const output = outputBase ? join(resolve(outputBase), `${Date.now()}-${process.pid}`) : null
if (output) mkdirSync(output, { recursive: true })
const report = { checks: [], success: false, work, output, stages: [], browserEvents: [] }
const startedAt = Date.now()
const stage = (name) => {
  report.phase = name
  const entry = { name, elapsedMs: Date.now() - startedAt }
  report.stages.push(entry)
  console.log(`PROJECTIONS_STAGE ${JSON.stringify(entry)}`)
}
const checkpoint = (...checks) => {
  report.checks.push(...checks)
  stage(typeof checks[0] === 'string' ? checks[0] : '布局与记号检查完成')
}
stage('启动隔离 Vite 与 Chrome')
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
async function screenshot(name) {
  if (!output) return
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(output, name), Buffer.from(shot.data, 'base64'))
}
let log = ''
child.on('exit', (code, signal) => {
  report.browserExit = { code, signal, elapsedMs: Date.now() - startedAt }
})
child.stderr.on('data', (data) => {
  log += data.toString()
})
try {
  // 等的是 Vite 起来（机器忙时要更久），不是被测的东西
  await until(async () => (await fetch(`${base}/`)).ok, '回环界面服务', 60000)
  const port = await until(
    () => Number(readFileSync(join(work, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0]),
    '浏览器端口',
  )
  assert.ok(
    execFileSync('ps', ['-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' }).includes(
      `${work}/profile`,
    ),
  )
  // 调试端口先就绪，初始页面可能还没建好。
  const page = await until(async () => {
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return tabs.find((tab) => tab.type === 'page')?.webSocketDebuggerUrl
  }, '浏览器页面')
  cdp = await Cdp.connect(page)
  cdp.listeners.add((message) => {
    if (
      ['Runtime.exceptionThrown', 'Inspector.targetCrashed', 'Inspector.detached'].includes(
        message.method,
      )
    ) {
      report.browserEvents.push({ ...message, elapsedMs: Date.now() - startedAt })
      if (report.browserEvents.length > 50) report.browserEvents.shift()
    }
  })
  await cdp.call('Inspector.enable')
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
    report.expression = expression
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
  stage('打开模拟核心页面，等待两个投影组')
  await cdp.call('Page.navigate', { url: `${base}/` })
  await until(
    () => run(() => document.querySelectorAll('[data-projection]').length === 2),
    '两个投影组',
  )
  await run(() => document.querySelector('[data-act=onboard-close]')?.click())
  await run(() => window.__litchLook.set({ skin: 'standard', theme: 'light', lang: 'zh-CN' }))
  // 探针要直接调界面模块（外部打开会话、定位开关、侧栏宽度）。在 CDP 里等页面动态 import 的结果，Chrome 偶尔在它落定前
  // 回收这个 promise（Promise was collected；冷启动的 CI 上常见，没有导航、没有请求）。所以只在 until 里取，取到挂在
  // window 上，之后同步调用；页面重载后重取
  const modules = () => {
    stage('读取界面探针模块')
    return until(
      () =>
        run(() =>
          Promise.all([import('/src/app/actions.ts'), import('/src/sidebar/state.ts')]).then(
            ([actions, state]) => {
              window.__projectionProbe = { actions, state }
              return true
            },
          ),
        ),
      '界面模块',
    )
  }
  await modules()
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
  checkpoint('主项归并、默认五项、展开子树、更多增加十项')
  // 和置顶区、本机分组同一套设备标记：登记了多台设备（模拟核心如此）时，本机的行也写设备名
  assert.ok(
    await run(() =>
      ['unread', 'recent'].every((kind) => {
        const rows = [
          ...document.querySelectorAll(`[data-projection=${kind}] [data-depth="0"] .ss-row`),
        ]
        return rows.length > 0 && rows.every((row) => !!row.querySelector('.projection-device'))
      }),
    ),
    '多台设备时平铺行都写设备名，本机行也写',
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
  assert.deepEqual(selectedCopies.tree, [], '点未读行不选中树里的副本')
  assert.deepEqual(selectedCopies.projections, ['s3'], '只选中被点击的未读行')
  assert.equal(
    selectedCopies.unreadCount,
    selectedCopies.unreadRows,
    '未读计数不包含已读的原位保留副本',
  )
  checkpoint('只高亮点击的投影行，目录和其他投影不高亮，未读计数不受副本影响')
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
  await screenshot('unread-held-after-double-click.png')
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
  checkpoint('未读原位暂留、已读样式、鼠标连点不串项、切走移除、已读不回填、设备名与时间口径')
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
  checkpoint('打开立即清未读、短暂查看不刷新最近、连续前台五秒后记录达标时刻')
  // 唯一选中：放在停留计时之后。夹在点开 s3 和“短暂打开”的断言之间，慢的机器上会让 s3 停留满五秒
  const currentRows = () =>
    run(() =>
      [...document.querySelectorAll('.ss-row[aria-current="true"]')].map((row) => ({
        sessionId: row.closest('[data-session]').dataset.session,
        source: row.closest('[data-projection]')?.dataset.projection ?? 'tree',
        selected: row.classList.contains('sel'),
      })),
    )
  await until(async () => (await currentRows())[0]?.source === 'recent', '最近行唯一选中')
  assert.deepEqual(await currentRows(), [{ sessionId: 's3', source: 'recent', selected: true }])
  await click('[data-sidebar-mode=manager]')
  await until(() => run(() => !document.querySelector('[data-projection]')), '切到经理模式')
  assert.ok(
    await run(
      () => document.querySelector('.cmp-text')?.dataset.composerSession === '["local","s3"]',
    ),
    '切树仍显示原普通会话',
  )
  await click('[data-sidebar-mode=chat]')
  await until(() => run(() => !!document.querySelector('[data-projection=recent]')), '返回对话模式')
  assert.deepEqual(
    await currentRows(),
    [{ sessionId: 's3', source: 'recent', selected: true }],
    '切换模式仍保留实际点击的最近行',
  )
  await click('[data-sidebar-mode=manager]')
  await click('[data-manager-id=m1] .mg-pick')
  await until(
    () =>
      run(
        () =>
          document.querySelector('[data-manager-id=m1] .mg-pick')?.getAttribute('aria-current') ===
          'page',
      ),
    '经理树明确选择经理',
  )
  await click('[data-sidebar-mode=chat]')
  await until(
    () => run(() => !!document.querySelector('[data-projection=recent]')),
    '再次返回对话模式',
  )
  assert.ok(
    await run(
      () => !!document.querySelector('[data-manager="session"][data-manager-id=m1] .mg-board'),
    ),
    '切回对话树仍显示最后选中的经理',
  )
  await click('.dev-group[data-device=local] [data-session=s3] .ss-row')
  await until(async () => (await currentRows())[0]?.source === 'tree', '树行唯一选中')
  assert.deepEqual(await currentRows(), [{ sessionId: 's3', source: 'tree', selected: true }])
  assert.equal(
    await run(() => document.querySelectorAll('.projection-group .ss-row.sel').length),
    0,
  )
  await click(`${recent} [data-session=s3] .ss-row`)
  await run(() => {
    const row = document.querySelector('[data-projection=recent] [data-session=s3] .ss-row')
    row.focus()
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  })
  await until(
    () => run(() => document.activeElement?.getAttribute('aria-current') === 'true'),
    '方向键跟随唯一当前项',
  )
  assert.equal((await currentRows()).length, 1)
  assert.equal(
    await run(() => document.activeElement.closest('[data-projection]')?.dataset.projection),
    'recent',
  )
  await click(`${recent} [data-session=s3] .ss-row`)
  await run(() =>
    window.__projectionProbe.actions.requestOpenSession({ deviceId: 'local', sessionId: 's3' }),
  )
  await until(
    async () => (await currentRows())[0]?.source === 'tree',
    '外部重新打开当前对话选中树行',
  )
  assert.deepEqual(await currentRows(), [{ sessionId: 's3', source: 'tree', selected: true }])
  await run(() => window.__projectionProbe.state.setSidebarAutoLocate(false))
  await run(() =>
    window.__projectionProbe.actions.requestOpenSession({ deviceId: 'local', sessionId: 's4' }),
  )
  await until(async () => (await currentRows()).length === 0, '关闭自动定位后外部切换不新增选中')
  assert.equal(await run(() => document.querySelectorAll('.ss-row.sel').length), 0)
  await click(`${recent} [data-session=s3] .ss-row`)
  await until(async () => (await currentRows())[0]?.source === 'recent', '关闭定位仍可直接点击选中')
  await run(() => window.__projectionProbe.state.setSidebarAutoLocate(true))
  await until(async () => (await currentRows())[0]?.source === 'tree', '开启自动定位定位树行')
  checkpoint('外部重新打开选树行，关闭自动定位不新增选中，直接点击不受定位开关影响')
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
    // 设备色画在每行行首的色块上（和置顶区、本机分组同一套），不再挂在整块上
    [...document.querySelectorAll('[data-projection=recent] .projection-block')].map((b) => {
      const d = document.querySelector(`.dev-group[data-device=${b.dataset.device}]`)
      const tick = b.querySelector('.dev-tick')
      return {
        device: b.dataset.device,
        color: tick && getComputedStyle(tick).getPropertyValue('--wire'),
        original: d && getComputedStyle(d).getPropertyValue('--wire'),
      }
    }),
  )
  assert.ok(
    colors.length > 0 && colors.every((row) => row.color && row.color === row.original),
    '设备色一致',
  )
  assert.ok(
    await run(
      () =>
        !!document.querySelector(
          '[data-projection=recent] .projection-block[data-device=gpu] .dev-tick.off',
        ),
    ),
    '离线设备的色块画成虚的',
  )
  checkpoint('查看清未读并更新最近、独立折叠、跨设备项目聚合、离线缓存、设备色一致')
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
  checkpoint('投影项目可改名并同步原树、新建对话入口')
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
  // 重载后是新的模块实例
  await modules()
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
  checkpoint('浏览记录、聚合、默认条数和折叠本机持久化')
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
  await run(() => window.__projectionProbe.state.setSidebarWidth(240))
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
  checkpoint('可访问命名分组、带单位的未读计数、最近无总数、菜单勾选及 radio/checkbox 状态')
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
      await screenshot(`${skin}-${theme}-240.png`)
      checkpoint({ skin, theme, ...geometry })
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
      // 离线不在行上写字：标题不被挤，“离线”留在悬停提示和读屏名称里
      const narrow = await run(() =>
        [...document.querySelectorAll('[data-projection=recent] [data-depth="0"] .ss-row')].map(
          (row) => ({
            title: row.querySelector('.title')?.getBoundingClientRect().width ?? 0,
            offline: !!row.querySelector('.dev-tick.off'),
            name: row.textContent ?? '',
            hint: row.querySelector('.projection-device')?.getAttribute('title') ?? '',
            shown: row.querySelector('.projection-device')?.getBoundingClientRect().width ?? 0,
            label: row.querySelector('.projection-device')?.firstChild?.textContent ?? '',
          }),
        ),
      )
      assert.ok(
        narrow.every((row) => row.title >= 40),
        `窄侧栏标题不被设备名挤压：${JSON.stringify(narrow.map((row) => Math.round(row.title)))}`,
      )
      const away = narrow.filter((row) => row.offline)
      assert.ok(away.length > 0, '有离线设备的行')
      assert.ok(
        away.every(
          (row) =>
            !row.label.includes('离线') && row.name.includes('离线') && row.hint.includes('离线'),
        ),
        `离线行不显示“离线”，读屏名称和悬停提示里有：${JSON.stringify(away)}`,
      )
      assert.ok(
        await run(() =>
          [...document.querySelectorAll('[data-projection=recent] [data-depth="0"] .ss-row')].every(
            (row) => !!row.querySelector('.projection-device'),
          ),
        ),
        '多台设备时平铺行都写设备名',
      )
      assert.equal(
        await run(() =>
          [...document.querySelectorAll('.projection-body')].some(
            (e) => e.scrollWidth > e.clientWidth + 1,
          ),
        ),
        false,
      )
      await screenshot(`${skin}-${theme}-flat-240.png`)
      await click(`${recent} .projection-head .row-more button`)
      await option('按项目聚合')
    }
  }
  // 新的一份活动记录只含经理与工作线，验证主项归并及跨模式入口。
  stage('重载活动记录，等待经理与工作线归并')
  await run(() =>
    localStorage.setItem(
      'litch.sidebar.activity',
      JSON.stringify([
        { deviceId: 'local', sessionId: 'manager-k1', at: Date.now() - 2000 },
        { deviceId: 'local', sessionId: 'manager-k2', at: Date.now() - 1000 },
        { deviceId: 'build', sessionId: 'm2', at: Date.now() },
      ]),
    ),
  )
  await cdp.call('Page.reload')
  await until(async () => (await roots()).length === 2, '经理与工作线合并成两个经理主项')
  assert.deepEqual((await roots()).sort(), ['m1', 'm2'])
  assert.ok(
    await run(
      () =>
        !!document.querySelector('[data-projection=unread] [data-session=m1] .ss-row.is-unread'),
    ),
    '工作线有未读结果时经理主项进入未读',
  )
  // 经理主项的记号列带经理框（读屏“经理”），普通主项不带；框叠在状态记号那一格里，不加宽、不加行高
  const marks = await run(() =>
    [...document.querySelectorAll('[data-projection] .tree-node[data-depth="0"] > .row-line')].map(
      (line) => {
        const mark = line.querySelector(':scope > .ss-row > i.st')
        const box = mark.getBoundingClientRect()
        return {
          session: line.dataset.session,
          framed: mark.classList.contains('mgr'),
          label: mark.getAttribute('aria-label'),
          size: [Math.round(box.width), Math.round(box.height)].join('x'),
          row: Math.round(line.querySelector(':scope > .ss-row').getBoundingClientRect().height),
          unread: mark.classList.contains('unread'),
        }
      },
    ),
  )
  const plain = await run(() => {
    const line = document.querySelector(
      '.sb-scroll .tree-node[data-depth="0"] > .row-line[data-session]:not([data-projection] *)',
    )
    const mark = line?.querySelector(':scope > .ss-row > i.st')
    const box = mark?.getBoundingClientRect()
    return box
      ? {
          size: [Math.round(box.width), Math.round(box.height)].join('x'),
          row: Math.round(line.querySelector(':scope > .ss-row').getBoundingClientRect().height),
        }
      : null
  })
  assert.ok(plain, '普通会话行')
  assert.ok(
    marks.length >= 2 &&
      marks.every(
        (mark) =>
          mark.framed === (mark.session === 'm1' || mark.session === 'm2') &&
          (mark.framed ? mark.label === '经理' : mark.label === null) &&
          mark.size === plain.size &&
          mark.row === plain.row,
      ) &&
      marks.some((mark) => mark.framed && mark.unread),
    `经理主项的记号列没有经理框，或框改变了记号与行的尺寸：${JSON.stringify({ marks, plain })}`,
  )
  checkpoint({ managerMarks: marks, plainRow: plain })
  assert.equal(
    await run(() => !!document.querySelector('[data-projection=recent] [data-session=manager-k1]')),
    false,
    '工作线默认收起',
  )
  await click('[data-projection=recent] [data-session=m1] .tree-fold')
  await until(
    () => run(() => !!document.querySelector('[data-projection=recent] [data-session=manager-k1]')),
    '展开经理的工作线',
  )
  assert.equal(
    await run(
      () =>
        document.querySelector('[data-projection=recent] [data-session=manager-k1]').dataset.parent,
    ),
    'm1',
  )
  assert.deepEqual((await roots()).sort(), ['m1', 'm2'], '工作线不成为顶层主项')
  const chatShown = async (sessionId, source) => {
    await until(
      () =>
        run(
          (id) =>
            document.querySelector('[data-sidebar-mode=chat]')?.getAttribute('aria-pressed') ===
              'true' &&
            !document.querySelector('[data-manager="session"]') &&
            document.querySelector('.cmp-text')?.dataset.composerSession ===
              JSON.stringify(['local', id]),
          sessionId,
        ),
      `在对话视图打开 ${sessionId}`,
    )
    assert.deepEqual(await currentRows(), [{ sessionId, source, selected: true }])
  }
  const folding = () =>
    run(() => ({
      // 进入经理工作台会单独记下经理树的展开状态；这里只核对普通投影不变。
      folds: Object.fromEntries(
        Object.entries(window.__projectionProbe.state.sidebarNow().folds).filter(
          ([scope]) => !scope.startsWith(':manager:'),
        ),
      ),
      projections: localStorage.getItem('litch.sidebar.projections'),
      expanded: document
        .querySelector('[data-projection=recent] [data-session=m1] .tree-fold')
        ?.getAttribute('aria-expanded'),
    }))
  await modules()
  const beforeManager = await folding()
  const managerShown = () =>
    until(
      () =>
        run(
          () =>
            document.querySelector('[data-sidebar-mode=chat]')?.getAttribute('aria-pressed') ===
              'true' &&
            !!document.querySelector('[data-manager="session"][data-manager-id=m1] .mg-board') &&
            !!document.querySelector('[data-manager="session"][data-manager-id=m1] .mg-chat'),
        ),
      '投影打开同一经理工作台',
    )
  await click('[data-projection=recent] [data-session=m1] .ss-row')
  await managerShown()
  await screenshot('manager-workbench-from-recent.png')
  await click('[data-sidebar-mode=chat]')
  await until(() => run(() => !!document.querySelector('[data-projection=recent]')), '返回投影')
  assert.deepEqual(await folding(), beforeManager, '经理会话点击不改变折叠状态')
  await click('[data-projection=recent] [data-session=manager-k1] .ss-row')
  await chatShown('manager-k1', 'recent')
  assert.deepEqual(await folding(), beforeManager, '工作线点击不改变折叠状态')
  checkpoint('最近中的经理进入工作台，工作线保留普通对话与展开状态')
  await click(`${unread} [data-session=m1] .ss-row`)
  await managerShown()
  await click('[data-sidebar-mode=chat]')
  await until(() => run(() => !!document.querySelector('[data-projection=unread]')), '返回未读投影')
  await click(`${unread} [data-session=m1] .tree-fold`)
  const beforeUnread = await folding()
  await click(`${unread} [data-session=manager-k2] .ss-row`)
  await chatShown('manager-k2', 'unread')
  assert.deepEqual(await folding(), beforeUnread)
  assert.ok(
    await run(() => !!document.querySelector('[data-projection=unread] [data-session=m1]')),
    '读完最后一条工作线后，仍在查看的树原位暂留',
  )
  await screenshot('manager-line-chat-from-unread.png')
  // 在经理树明确选中经理后，切回对话树也不能恢复之前的工作线正文。
  await click('[data-sidebar-mode=manager]')
  await click('[data-manager-id=m1] .mg-pick')
  await until(
    () => run(() => !!document.querySelector('[data-manager="session"][data-manager-id=m1]')),
    '经理入口照常打开经理页',
  )
  await click('[data-sidebar-mode=chat]')
  await until(
    () =>
      run(() => !!document.querySelector('[data-manager="session"][data-manager-id=m1] .mg-board')),
    '切树保留最后选中的经理工作台',
  )
  assert.equal(
    await run(() => !!document.querySelector('[data-projection=unread] [data-session=m1]')),
    false,
    '离开后不恢复已读的未读暂留树',
  )
  // 普通设备树按现有设计排除了经理及工作线；经理专属树仍属于经理视图。
  assert.equal(
    await run(
      () =>
        document.querySelectorAll(
          '.dev-group [data-session=m1], .dev-group [data-session=manager-k1]',
        ).length,
    ),
    0,
  )
  checkpoint('未读经理进入工作台，工作线保留普通对话；普通设备树不重复列经理')
  // 当前父会话打开时，子会话完成才让整棵树进入未读；点最后一个未读子会话不能让树消失。
  for (const leave of ['tree', 'page', 'manager', 'settings']) {
    stage(`检查子会话晚到未读：${leave}`)
    await run(() => {
      document.documentElement.dataset.unreadReload = 'old'
    })
    await cdp.call('Page.reload')
    await until(
      () =>
        run(
          () =>
            !document.documentElement.dataset.unreadReload &&
            !!document.querySelector('[data-projection=unread]'),
        ),
      '新的模拟核心页面',
    )
    await modules()
    await run(() =>
      window.__projectionProbe.actions.requestOpenSession({ deviceId: 'local', sessionId: 's4' }),
    )
    await until(
      () =>
        run(
          () =>
            document.querySelector('.cmp-text')?.dataset.composerSession ===
            JSON.stringify(['local', 's4']),
        ),
      '打开普通父会话',
    )
    await until(() => run(() => !document.querySelector('.send.stop')), '父会话空闲')
    await run(() => {
      const input = document.querySelector('.cmp-text')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
        input,
        '派子会话',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await run(() =>
      document
        .querySelector('.cmp-text')
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
        ),
    )
    await until(
      () => run(() => !!document.querySelector('[data-projection=unread] [data-session=s4]')),
      '子会话完成后父项进入未读',
      30000,
    )
    // 展开偏好会跨重载保存；这一轮只在尚未展开时点开，不能把上一轮的展开状态关掉。
    if (
      await run(
        () =>
          document
            .querySelector('[data-projection=unread] [data-session=s4] .tree-fold')
            .getAttribute('aria-expanded') === 'false',
      )
    )
      await click(`${unread} [data-session=s4] .tree-fold`)
    const childRows = () =>
      run(() =>
        [
          ...document.querySelectorAll(
            '[data-projection=unread] [data-parent=s4] .ss-row.is-unread',
          ),
        ].map((e) => e.closest('[data-session]').dataset.session),
      )
    await until(async () => (await childRows()).length === 2, '两个普通子会话未读', 30000)
    const childIds = await childRows()
    // 子会话结束还会唤醒父会话，不能把“两个子会话未读”当成整棵树已经结束。
    // 保持父会话打开直到唤醒回合结束：否则离开后父会话的新结果会合法地再次进入未读。
    await until(
      () =>
        run(
          (ids) =>
            document.querySelector('.cmp-text')?.dataset.composerSession ===
              JSON.stringify(['local', 's4']) &&
            !document.querySelector('.send.stop') &&
            ['s4', ...ids].every(
              (id) =>
                !!document.querySelector(
                  '[data-projection=unread] [data-session="' + id + '"] .ss-row > .st.unread',
                ),
            ),
          childIds,
        ),
      '父会话的唤醒回合和子会话全部结束',
      30000,
    )
    const position = () =>
      run(() =>
        [
          ...document.querySelectorAll(
            '[data-projection=unread] .tree-node[data-depth="0"] > [data-session]',
          ),
        ].map((e) => e.dataset.session),
      )
    const before = await position()
    for (const id of childIds) {
      await click(unread + ' [data-session="' + id + '"] .ss-row')
      await until(
        () =>
          run(
            (id) =>
              !document.querySelector(
                '[data-projection=unread] [data-session="' + id + '"] .ss-row.is-unread',
              ),
            id,
          ),
        '子会话已读',
      )
    }
    assert.ok(
      await run(() => !!document.querySelector('[data-projection=unread] [data-session=s4]')),
      '读完最后一个普通子会话后，整棵树应留在未读原位置',
    )
    const held = await run(() => {
      const root = document.querySelector('[data-projection=unread] [data-session=s4]')
      return {
        unread: root.querySelector('.ss-row').classList.contains('is-unread'),
        weight: getComputedStyle(root.querySelector('.title')).fontWeight,
        children: [...document.querySelectorAll('[data-projection=unread] [data-parent=s4]')].map(
          (e) => e.dataset.session,
        ),
        unreadChildren: document.querySelectorAll(
          '[data-projection=unread] [data-parent=s4] .ss-row.is-unread',
        ).length,
        count: Number(
          document.querySelector('[data-projection=unread] .projection-count').textContent,
        ),
      }
    })
    assert.deepEqual(await position(), before, '清完子会话未读后根项仍在原位置')
    assert.equal(held.unread, false, '根行恢复已读样式')
    assert.equal(held.weight, '400', '根行恢复普通字重')
    assert.equal(held.unreadChildren, 0)
    assert.deepEqual(held.children, childIds, '子树保持展开，子会话仍在原顺序')
    assert.equal(held.count, before.length - 1, '真实未读计数不包含暂留树')
    // 同棵树内回根和切兄弟都不能释放暂留。
    await click(unread + ' [data-session=s4] .ss-row')
    await click(unread + ' [data-session="' + childIds[0] + '"] .ss-row')
    assert.deepEqual(await position(), before)
    if (leave === 'tree') {
      await run(() =>
        window.__projectionProbe.actions.requestOpenSession({ deviceId: 'local', sessionId: 's3' }),
      )
    } else if (leave === 'page') {
      await run(() => window.__projectionProbe.actions.requestNewSession())
    } else if (leave === 'settings') {
      await run(() => window.__projectionProbe.actions.requestSettings('look'))
    } else {
      await click('[data-sidebar-mode=manager]')
      await until(() => run(() => !document.querySelector('[data-projection]')), '经理模式隐藏投影')
      await click('[data-sidebar-mode=chat]')
      await until(
        () => run(() => !!document.querySelector('[data-projection=unread]')),
        '回到对话模式',
      )
    }
    await until(
      () => run(() => !document.querySelector('[data-projection=unread] [data-session=s4]')),
      '离开树后移出暂留项：' + leave,
    )
    assert.ok(
      await run(() => !!document.querySelector('[data-projection=recent] [data-session=s4]')),
      '清未读不移除最近中的主项',
    )
    await run(
      (id) =>
        window.__projectionProbe.actions.requestOpenSession({ deviceId: 'local', sessionId: id }),
      childIds[0],
    )
    await until(
      () =>
        run(
          (id) =>
            document.querySelector('.cmp-text')?.dataset.composerSession ===
            JSON.stringify(['local', id]),
          childIds[0],
        ),
      '已读子会话已重新打开',
    )
    assert.equal(
      await run(() => !!document.querySelector('[data-projection=unread] [data-session=s4]')),
      false,
      '返回已读子会话不重新进入未读',
    )
    checkpoint('普通子树晚到未读：原位暂留、已读样式、展开保持、树内切换；离开释放：' + leave)
  }
  assert.deepEqual(errors, [])
  report.success = true
} catch (error) {
  await diagnoseFailure(report, error, async () => {
    if (!cdp) return
    report.debug = await cdp.call('Runtime.evaluate', {
      expression:
        'JSON.stringify({storage:{...localStorage},rows:[...document.querySelectorAll("[data-projection=recent] [data-session]")].map(e=>e.dataset.session)})',
      returnByValue: true,
    })
    await screenshot('failure.png')
  })
  throw error
} finally {
  if (output) {
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
    writeFileSync(join(outputBase, 'report.json'), JSON.stringify(report, null, 2))
    writeFileSync(join(output, 'browser.log'), log)
  }
  cdp?.close()
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
  vite?.kill('SIGTERM')
  rmSync(work, { recursive: true, force: true })
}
console.log(JSON.stringify(report, null, 2))
