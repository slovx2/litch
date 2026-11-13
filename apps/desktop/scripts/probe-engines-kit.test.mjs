import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'

const { code } = await transform(
  readFileSync(new URL('../src/probe-engines-kit.mts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'iife', globalName: 'probes' },
)

// 执行实际注入页面的探针；用可推进的时钟模拟回合结束后仍有正文在逐字显示。
function fixture(settleAt = 1200) {
  let now = 1
  const turn = {}
  const half = 'claude-code 收到：从界面新建的头一句（claude-c'
  const full = `${half}ode）完整结尾`
  const text = () => (now < settleAt ? half : full)
  const page = {
    __filesKit: {
      one: (selector) => {
        if (selector === '.dock textarea.cmp-text') return {}
        if (selector === '.agent-message > .md.live') return now < settleAt ? {} : null
        if (selector === '.turn-foot span') return { textContent: '完成' }
        return null
      },
      all: (selector) => {
        if (selector === '.turn') return [turn]
        if (selector === ':scope > .agent-message > .md') return [{ textContent: text() }]
        return []
      },
      text: (node) => node?.textContent ?? '',
      sleep: async (ms) => {
        now += ms
      },
    },
  }
  const context = { window: page, performance: { now: () => now } }
  runInNewContext(`${code}\nprobes.installEnginesKit()`, context)
  return { kit: page.__enginesKit, now: () => now, full }
}

test('回合已完成但正文仍在逐字显示：超过旧的 300ms 静默窗口也不取半句', async () => {
  const { kit, now, full } = fixture()
  assert.equal(kit.foot(), '完成')
  assert.notEqual(kit.lastAnswer(), full)
  await kit.idle(2000)
  assert.ok(now() >= 1200)
  assert.equal(kit.lastAnswer(), full)
})

test('正文始终没有定稿：到截止时间报错，不能把回合完成当作文字已齐', async () => {
  const { kit } = fixture(Infinity)
  await assert.rejects(kit.idle(600), /等不到：这一轮结束/)
})

test('已定稿的正文照常完成，取样不依赖预期回答的内容', async () => {
  const { kit, full } = fixture(0)
  await kit.idle(600)
  assert.equal(kit.lastAnswer(), full)
})

test('命令没有动词文字、状态只在图标上时，骨架仍包含完整命令与状态', async () => {
  for (const status of ['待审批', '通过', '已拒绝']) {
    const item = {}
    const steps = { matches: (selector) => selector === '.steps' }
    const proc = { matches: (selector) => selector === '.proc' }
    const turn = { children: [proc] }
    const page = {
      __filesKit: {
        one: (selector, scope) => {
          if (selector === '.proc-body' && scope === proc) return { children: [steps] }
          if (scope !== item) return null
          if (selector === '.item-head .step-mark')
            return { getAttribute: (name) => (name === 'aria-label' ? status : null) }
          if (selector === '.tgt') return { textContent: 'echo fixture-ran-$((6*7))' }
          return null
        },
        all: (selector, scope) => {
          if (selector === '.turn') return [turn]
          if (selector === '.item' && scope === steps) return [item]
          return []
        },
        text: (node) => node?.textContent ?? '',
        frame: async () => {},
      },
    }
    runInNewContext(`${code}\nprobes.installEnginesKit()`, { window: page })
    const outline = await page.__enginesKit.outline()
    assert.equal(outline[0][0], `运行 echo fixture-ran-$((6*7))｜${status}`)
  }
})
