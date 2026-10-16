// 强度档的名字：对面可能报的每一档都要有中文和英文的叫法，不能直接把标识露给人看。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EFFORT_TEXT } from '../src/composer/efforts.ts'
import { en } from '../src/i18n/en.ts'
import { zhCN } from '../src/i18n/zh-CN.ts'

/**
 * 会报上来的强度档：上游 codex 的 ReasoningEffort（rust-v0.162.0-alpha.20 的
 * codex-rs/protocol/src/openai_models.rs，none 到 persistent；codex 0.160 的模型清单里实际有 ultra），
 * Claude Code 入口报的（low 到 max）是它的子集，Pi 的思考档多一个 off（pi-ai 的 getSupportedThinkingLevels）。
 * dsh 的档位是它自己的模型目录给的，这一版目录里也在这些之内
 */
const REPORTED = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'persistent',
  'off',
]

test('对面可能报的每一档强度都有名字，两种语言都有', () => {
  for (const id of REPORTED) {
    const key = EFFORT_TEXT[id]
    assert.ok(key, `强度 ${id} 没有名字`)
    assert.equal(typeof zhCN[key], 'string', `中文里没有 ${key}`)
    assert.equal(typeof en[key], 'string', `英文里没有 ${key}`)
  }
})

test('不同的档叫法不重样，同一个意思的除外（Pi 的 off 就是不思考）', () => {
  const same = new Map([['off', 'none']])
  for (const lang of [zhCN, en]) {
    const seen = new Map()
    for (const id of REPORTED) {
      const name = lang[EFFORT_TEXT[id]]
      const earlier = seen.get(name)
      if (earlier !== undefined) {
        assert.equal(
          same.get(id) ?? id,
          same.get(earlier) ?? earlier,
          `${id} 和 ${earlier} 叫法一样`,
        )
      }
      seen.set(name, id)
    }
  }
})
