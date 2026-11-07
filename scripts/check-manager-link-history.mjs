// 正式 App 的看板来源、决策和事项会话链接回归；自动启动 Vite 与隔离 headless Chrome。
// node scripts/check-manager-link-history.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const vite = await createServer({
  root: new URL('../packages/ui', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  logLevel: 'error',
})
await vite.listen()
const base = vite.resolvedUrls.local[0].replace(/\/$/, '')
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
if (!binary) throw new Error('缺少隔离 Chrome for Testing')
const work = mkdtempSync(join(tmpdir(), 'litch-manager-history-'))
const browser = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    '--disable-background-networking',
    '--window-size=1280,900',
    'about:blank',
  ],
  {
    env: { PATH: process.env.PATH, HOME: work, TMPDIR: work },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
let output = ''
const exited = new Promise((resolve) => browser.once('exit', resolve))
browser.stderr.on('data', (chunk) => {
  output += chunk
})
let cdp
try {
  const endpoint = await until(
    () => output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1],
    '浏览器',
  )
  cdp = await Cdp.connect(endpoint)
  const page = (await cdp.call('Target.getTargets')).targetInfos.find(
    (entry) => entry.type === 'page',
  )
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
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
  const has = (selector) => run((s) => !!document.querySelector(s), selector)
  const click = async (selector) => {
    await until(() => has(selector), selector)
    await run((s) => document.querySelector(s).click(), selector)
  }
  await call('Page.navigate', { url: `${base}/test/manager-open-fixture.html?lang=zh-CN` })
  await click('[data-sidebar-mode="manager"]')
  await click('[data-manager-id="m1"] .mg-pick')
  await until(() => has('.mg-page'), '经理页面')
  await click('[data-board-tab="suggestions"]')
  await run(() => {
    const { store, keys } = window.__managerOpen
    store.set(
      keys.suggestions,
      Array.from({ length: 20 }, (_, i) => ({
        deviceId: 'local',
        managerId: 'm1',
        managerReview: { state: 'endorsed' },
        source: {
          threadId: 's2',
          title: '来源工作线',
          harness: 'claude-code',
          cwd: '/work',
          archived: false,
          project: null,
        },
        proposal: {
          id: `history-${i}`,
          title: `建议 ${i}`,
          prompt: '执行任务',
          background: '验证从看板返回。',
          status: 'proposed',
          kind: 'fresh',
          createdAt: Date.now() - i,
          updatedAt: Date.now(),
          worktree: false,
        },
      })),
    )
  })
  for (const tab of ['suggestions', 'decisions', 'items'])
    for (const back of ['button', 'keyboard', 'mouse']) {
      await click(`[data-board-tab="${tab}"]`)
      await run(() => {
        const { store, keys } = window.__managerOpen
        const key = keys.managerBoard('local', 'm1'),
          view = store.get(key)
        store.set(key, {
          ...view,
          board: {
            ...view.board,
            relations: [
              ...(view.board.relations ?? []).filter(
                (relation) => !relation.id.startsWith('history-'),
              ),
              ...['D-17', 'I-1'].map((id) => ({
                id: `history-${id}`,
                from: { kind: id.startsWith('I') ? 'item' : 'issue', target: id },
                to: { kind: 'thread', target: 's2', label: '来源工作线' },
                kind: 'related',
                by: 'manager',
                at: Date.now(),
              })),
            ],
          },
        })
      })
      const source =
        tab === 'suggestions'
          ? '[data-act="open-source"]'
          : `[data-relations="${tab === 'decisions' ? 'D-17' : 'I-1'}"] [data-relation-target="s2"]`
      await until(() => has(source), '看板中的会话链接')
      await run((selector) => {
        document.querySelector(selector)?.closest('details')?.setAttribute('open', '')
      }, source)
      await run(() => {
        const e = document.querySelector('.mg-body')
        e.scrollTop = 400
        e.dispatchEvent(new Event('scroll'))
      })
      const before = await run((selector) => {
        const y = document.querySelector('.mg-body').scrollTop
        document.querySelector(selector).click()
        return y
      }, source)
      assert.ok(before > 0, '复现需要确实滚动')
      await until(() => has(`[data-composer-session='["local","s2"]']`), '来源会话')
      assert.equal(
        await read('document.querySelector("[data-navigation=back]").disabled'),
        false,
        '历史必须可返回',
      )
      if (back === 'button') await click('[data-navigation="back"]')
      else
        await read(`(async()=>{
      document.activeElement?.blur()
      if (${JSON.stringify(back)}==='mouse') document.dispatchEvent(new MouseEvent('mouseup',{button:3,bubbles:true,cancelable:true}))
      else {
        const {currentPlatform}=await import('/src/app/platform.ts')
        const mac=currentPlatform()==='mac'
        document.dispatchEvent(new KeyboardEvent('keydown',{key:mac?'[':'ArrowLeft',metaKey:mac,altKey:!mac,bubbles:true,cancelable:true}))
      }
    })()`)
      await until(() => has('.mg-page'), '返回看板')
      await read(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      )
      await until(
        () => read(`document.querySelector('.mg-body').scrollTop === ${before}`),
        '恢复看板滚动位置',
      )
      assert.equal(
        await read(
          `document.querySelector('[data-board-tab="${tab}"]').getAttribute('${tab === 'items' ? 'aria-selected' : 'aria-pressed'}')`,
        ),
        'true',
        '回到原标签',
      )
      console.log(`${tab}/${back}：回到原标签，滚动 ${before}px`)
    }
  await click('[data-board-tab="inbox"]')
  await click('[data-board-tab="suggestions"]')
  await click('[data-act="open-source"]')
  await until(() => has(`[data-composer-session='["local","s2"]']`), '来源会话')
  // 经理目录仍在，但会话摘要缓存已被清理；目录确认的看板仍是有效历史。
  await run(() => {
    const { store, keys } = window.__managerOpen
    store.delete(keys.summary('local', 'm1'))
  })
  await click('[data-navigation="back"]')
  await until(() => has('.mg-page'), '摘要不在缓存时仍返回经理看板')
  console.log('MANAGER_LINK_HISTORY_PASS')
} finally {
  cdp?.ws.close()
  browser.kill()
  await exited
  await vite.close()
  rmSync(work, { recursive: true, force: true })
}
