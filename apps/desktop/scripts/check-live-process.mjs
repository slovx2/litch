// 隐藏窗口、隔离配置，使用正式 Transcript 验证插话、压缩、继续输出和收尾；不保留截图或验收目录。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureEnvironment } from '../../../scripts/fixture-environment.mjs'
import { withChromiumTestArgs } from '../../../third_party/litch-automation/scripts/chromium-test-args.mjs'

const require = createRequire(import.meta.url)
if (!process.versions.electron) {
  const { createServer } = await import('../../../packages/ui/node_modules/vite/dist/node/index.js')
  const scratch = mkdtempSync(join(tmpdir(), 'litch-live-process-'))
  const server = await createServer({
    root: fileURLToPath(new URL('../../../packages/ui', import.meta.url)),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  await server.listen()
  const child = spawn(require('electron'), withChromiumTestArgs([fileURLToPath(import.meta.url)]), {
    env: {
      ...fixtureEnvironment(),
      HOME: scratch,
      CODEX_HOME: join(scratch, 'codex'),
      LITCH_PROCESS_PROFILE: join(scratch, 'profile'),
      LITCH_PROCESS_URL: server.resolvedUrls.local[0],
      ...(process.env.LITCH_PROCESS_SHOT
        ? { LITCH_PROCESS_SHOT: process.env.LITCH_PROCESS_SHOT }
        : {}),
    },
    stdio: 'inherit',
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000)
  try {
    process.exitCode = await new Promise((resolve) =>
      child.on('exit', (code) => resolve(code ?? 1)),
    )
  } finally {
    clearTimeout(timeout)
    await server.close()
    rmSync(scratch, { recursive: true, force: true })
  }
} else {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', process.env.LITCH_PROCESS_PROFILE)
  void app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: { sandbox: true, backgroundThrottling: false },
    })
    try {
      await win.loadURL(`${process.env.LITCH_PROCESS_URL}test/live-process-fixture.html?lang=zh-CN`)
      const result = await win.webContents.executeJavaScript(`(${probe})()`)
      assert.equal(result.pendingOpen, true, '前段工具未结束时不可折叠')
      assert.equal(result.earlierFolded, true, '工具完成后仅前段收起')
      assert.equal(result.liveBeforeCompaction, true, '正在压缩不能结束最后一段')
      assert.equal(result.ordered, true, '新增说明必须留在压缩线之后')
      assert.equal(result.deltaVisible, true, '增量必须直接可见')
      assert.equal(result.finalStillOpen, true, 'final 已写完也等回合结束')
      assert.equal(result.completedFolded, true, '回合结束按原规则收起')
      assert.ok(result.grew > 100, '必须实际产生足够多的新内容')
      assert.ok(result.followGap <= 3, `跟随底部偏移 ${result.followGap}px`)
      console.log('LITCH_LIVE_PROCESS', JSON.stringify(result))
      for (const scenario of ['claude', 'codex', 'mixed']) {
        for (const follow of [false, true]) {
          await win.loadURL(
            `${process.env.LITCH_PROCESS_URL}test/message-phase-fixture.html?lang=zh-CN&scroll=1&scenario=${scenario}`,
          )
          const measured = await win.webContents.executeJavaScript(
            `(${phaseScrollProbe})(${follow})`,
          )
          assert.equal(measured.inView, true, '阅读锚点与过程必须实际在视口内')
          assert.equal(measured.keptNode, true, '回答节点不能被替换')
          assert.equal(measured.folded, true, '回合结束必须收起过程')
          assert.equal(measured.notes, scenario === 'claude' ? 2 : scenario === 'mixed' ? 1 : 0)
          assert.equal(measured.groups, scenario === 'codex' ? 0 : 2)
          assert.ok(
            measured.spread <= (follow ? 0.5 : 1),
            `${scenario} ${follow ? '贴底' : '离底'}位移 ${measured.spread}px`,
          )
          console.log(
            'LITCH_PHASE_SCROLL',
            scenario,
            follow ? 'follow' : 'free',
            JSON.stringify(measured),
          )
        }
      }
      await win.loadURL(`${process.env.LITCH_PROCESS_URL}test/live-process-fixture.html?lang=zh-CN`)
      const empty = await win.webContents.executeJavaScript(`(${emptyReasoningProbe})()`)
      assert.equal(empty.blankRows, 0, '展开步骤不允许只有图标和耗时')
      assert.equal(empty.blankHeads, 0, '收起汇总不能被空推理替换成空标题')
      assert.equal(empty.steps, 1, '纯空推理组不占一行')
      assert.equal(empty.compaction, true, '压缩保留自己的状态行')
      assert.equal(empty.readable, true, '后续可读摘要正常显示')
      if (process.env.LITCH_PROCESS_SHOT) {
        const image = await win.webContents.capturePage()
        mkdirSync(join(process.env.LITCH_PROCESS_SHOT, '..'), { recursive: true })
        writeFileSync(process.env.LITCH_PROCESS_SHOT, image.toPNG())
      }
      console.log('LITCH_EMPTY_REASONING', JSON.stringify(empty))
    } catch (error) {
      console.error(error)
      process.exitCode = 1
    } finally {
      win.destroy()
      app.exit(process.exitCode ?? 0)
    }
  })
}

async function emptyReasoningProbe() {
  const wait = async (test) => {
    for (let frame = 0; frame < 120; frame++) {
      if (test()) return
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    throw new Error('空推理过程验收超时')
  }
  window.liveProcess.emptyReasoning()
  await wait(() => document.querySelector('.compaction'))
  const heads = () => [...document.querySelectorAll('.steps-head')]
  const blankHeads = heads().filter(
    (head) =>
      !head.querySelector('.sum')?.textContent.trim() &&
      !head.querySelector('.now')?.textContent.trim(),
  ).length
  const steps = heads().length
  heads()[0]?.click()
  await wait(() => document.querySelector('.steps-body .item-head'))
  const blankRows = [...document.querySelectorAll('.item-head')].filter(
    (head) =>
      !head.querySelector('.verb')?.textContent.trim() &&
      !head.querySelector('.tgt')?.textContent.trim(),
  ).length
  const compaction =
    document.querySelector('.compaction')?.textContent.includes('正在压缩上下文') === true
  window.liveProcess.readableReasoning()
  await wait(() =>
    [...document.querySelectorAll('.steps-head')].some((head) =>
      head.textContent.includes('检查星云项目的测试结果'),
    ),
  )
  return { blankRows, blankHeads, steps, compaction, readable: true }
}

// 高度改变的帧在应用尺寸补偿之后取样，不把尚未上屏的中间排版算作跳动。
async function phaseScrollProbe(follow) {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
  for (let i = 0; i < 60 && !document.querySelector('[data-search-item="t:end"]'); i++)
    await frame()
  await document.fonts.ready
  const scroller = document.querySelector('.tr-scroll')
  const content = document.querySelector('.tr')
  const answer = document.querySelector('[data-search-item="t:end"] .md > :first-child')
  if (!answer) throw new Error('缺少最终回答锚点')
  if (follow) scroller.scrollTop = 0
  else
    scroller.scrollTop +=
      answer.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 320
  scroller.dispatchEvent(new Event('scroll'))
  for (let i = 0; i < 4; i++) await frame()
  const view = scroller.getBoundingClientRect()
  const body = document.querySelector('.turn:last-child .proc-body')
  const inView = follow
    ? Math.abs(scroller.scrollTop) <= 1
    : scroller.scrollTop < -1 &&
      answer.getBoundingClientRect().top > view.top &&
      answer.getBoundingClientRect().bottom < view.bottom &&
      body.getBoundingClientRect().bottom > view.top
  const read = () =>
    follow
      ? content.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom
      : answer.getBoundingClientRect().top
  const values = [read()]
  let height = content.getBoundingClientRect().height
  const observer = new ResizeObserver(() => {
    height = content.getBoundingClientRect().height
    values.push(read())
  })
  observer.observe(content)
  window.phaseFixture.finish()
  for (let i = 0; i < 12; i++) {
    await frame()
    if (height === content.getBoundingClientRect().height) values.push(read())
  }
  observer.disconnect()
  return {
    inView,
    keptNode: answer.isConnected,
    folded:
      !!document.querySelector('.turn:last-child .proc-head[aria-expanded="false"]') &&
      !document.querySelector('.turn:last-child .steps-body'),
    notes: ['before', 'finding'].filter((id) =>
      document.querySelector(`[data-search-item="t:${id}"]`),
    ).length,
    groups: document.querySelectorAll('.turn:last-child .steps-head[aria-expanded="false"]').length,
    spread: Math.max(...values) - Math.min(...values),
  }
}

async function probe() {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (check) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (check()) return
      await sleep(20)
    }
    throw new Error(`等待过程界面超时：${document.body.innerText.slice(-800)}`)
  }
  const item = (id) => document.querySelector(`[data-search-item="${id}"]`)
  const head = (key) => document.querySelector(`[data-anchor="p:t${key ? `:${key}` : ''}"]`)
  await until(() => window.liveProcess && document.querySelector('.turn'))
  const fixture = window.liveProcess
  fixture.start()
  await until(() => item('before') && document.querySelector('.compaction'))
  const pendingOpen = !!item('n0') && !head('')
  const liveBeforeCompaction = !!item('before') && !head('before')
  fixture.finishEarlier()
  await until(() => head('') && !item('n0'))
  const earlierFolded = !!head('n1') && !item('n1') && !!item('before')
  fixture.compacted()
  await until(() => document.querySelector('.compaction[data-state="completed"]'))
  const scroller = document.querySelector('.tr-scroll')
  scroller.scrollTop = 0
  scroller.dispatchEvent(new Event('scroll'))
  await sleep(80)
  const height = document.querySelector('.tr').getBoundingClientRect().height
  let ordered = true
  let followGap = 0
  for (let i = 0; i < 5; i++) {
    fixture.append(i)
    await until(() => item(`note-${i}`))
    await sleep(100)
    const note = item(`note-${i}`)
    const compact = document.querySelector('.compaction')
    ordered &&= !!(compact.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING)
    followGap = Math.max(
      followGap,
      Math.abs(
        document.querySelector('.tr').getBoundingClientRect().bottom -
          scroller.getBoundingClientRect().bottom,
      ),
    )
  }
  const grew = document.querySelector('.tr').getBoundingClientRect().height - height
  fixture.delta()
  await until(() => item('note-4')?.textContent.includes('流式增量可见'))
  const deltaVisible = !!item('note-4')
  fixture.final()
  await until(() => item('final'))
  const finalStillOpen = !!item('note-4') && !head('before')
  fixture.finish()
  await until(() => head('before') && !item('note-4'))
  return {
    pendingOpen,
    earlierFolded,
    liveBeforeCompaction,
    ordered,
    deltaVisible,
    finalStillOpen,
    completedFolded: !!item('final') && !document.querySelector('.running-line'),
    grew,
    followGap,
  }
}
