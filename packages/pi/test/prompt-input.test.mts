import assert from 'node:assert/strict'
import test from 'node:test'
import { promptInput } from '../src/turn.mjs'

const text = (value: string) => ({ type: 'text', text: value })
const skill = (name: string) => ({ type: 'skill', name, path: `/skills/${name}/SKILL.md` })

test('开头的技能和后面的话之间隔一个空格：Pi 认名字只认到第一个空格', async () => {
  // 隔的是换行的话，Pi 会把“notes\\n看一下”整个当成技能的名字，找不到，技能就没有展开
  assert.equal(
    (await promptInput([skill('notes'), text('看一下 这次改动')])).text,
    '/skill:notes 看一下 这次改动',
  )
  // 后面的话自己有几行：原样跟在后面
  assert.equal(
    (await promptInput([skill('notes'), text('第一行\n第二行')])).text,
    '/skill:notes 第一行\n第二行',
  )
  // 只有技能
  assert.equal((await promptInput([skill('notes')])).text, '/skill:notes')
  // Pi 一句话只展开开头的一项：再有的照原样留在话里
  assert.equal(
    (await promptInput([skill('notes'), skill('more'), text('好')])).text,
    '/skill:notes /skill:more\n好',
  )
  // 技能排在话后面的不在开头，Pi 不会展开：照原样
  assert.equal((await promptInput([text('好'), skill('notes')])).text, '好\n/skill:notes')
  // 没有技能的不变
  assert.equal(
    (await promptInput([text('一'), { type: 'mention', name: 'a.ts', path: '/w/a.ts' }])).text,
    '一\n/w/a.ts',
  )
})

test('斜杠命令照 Pi 自己的交互界面去掉首尾的空白：官方桌面端发来的 /plan 结尾带一个换行', async () => {
  // Pi 认命令名只认到第一个空格，结尾的换行会算进名字里（“plan\n”），认不出就当成一句话交给模型。
  // Pi 自己的交互界面提交之前整段去掉首尾空白（interactive-mode 的 onSubmit），所以在它那里打 /plan 回车是命令
  assert.equal((await promptInput([text('/plan\n')])).text, '/plan')
  assert.equal((await promptInput([text('  /plan start \n')])).text, '/plan start')
  assert.equal((await promptInput([text('\n/skill:notes 看一下\n')])).text, '/skill:notes 看一下')
  // 不是斜杠开头的话原样交给 Pi，回显和以前一样
  assert.equal((await promptInput([text('你好\n')])).text, '你好\n')
  assert.equal((await promptInput([text('  缩进的话')])).text, '  缩进的话')
})
