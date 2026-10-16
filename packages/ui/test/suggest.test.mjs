// 输入框里“打一个符号弹出一张单子”的判断：认触发词、过滤排序、哪几条命令叫得出来。
// 不起浏览器：suggest.ts、commands.ts 只有判断。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { cutTrigger, findTrigger, rank, standsAlone, step } = await import(
  '../src/composer/suggest.ts'
)
const { builtinCommands } = await import('../src/composer/commands.ts')

/** 光标在末尾时认出来的触发词 */
const atEnd = (text) => findTrigger(text, text.length)

test('触发词：斜杠要在一行的最前面；打了空白、又出现斜杠就不算了', () => {
  assert.deepEqual(atEnd('/'), { kind: 'slash', start: 0, end: 1, query: '' })
  assert.deepEqual(atEnd('/rev'), { kind: 'slash', start: 0, end: 4, query: 'rev' })
  // 换行之后的行首也算
  assert.deepEqual(atEnd('先看一下\n/rev'), { kind: 'slash', start: 5, end: 9, query: 'rev' })
  // 话中间的斜杠是路径、是“和/或”
  assert.equal(atEnd('看一下 /rev'), null)
  assert.equal(atEnd('和/或'), null)
  // 行首有空格的不算行首
  assert.equal(atEnd(' /rev'), null)
  // 打了空格就是不要这张单子了
  assert.equal(atEnd('/rev '), null)
  // 词里又有斜杠的是路径
  assert.equal(atEnd('/usr/bin'), null)
  assert.equal(atEnd(''), null)
  // 光标在词的中间：只算到光标为止
  assert.deepEqual(findTrigger('/review', 3), { kind: 'slash', start: 0, end: 3, query: 're' })
  // 光标停在斜杠前面：不是在打这个词
  assert.equal(findTrigger('/review', 0), null)
  // 光标在别的行上：那一行没有触发词
  assert.equal(findTrigger('/review\n好', 9), null)
})

test('触发词：@ 在一个词的开头就算，话中间也行；夹在词中间的（邮箱）不算；后面可以有斜杠', () => {
  assert.deepEqual(atEnd('@'), { kind: 'at', start: 0, end: 1, query: '' })
  assert.deepEqual(atEnd('看看 @src/app'), { kind: 'at', start: 3, end: 11, query: 'src/app' })
  assert.deepEqual(atEnd('第一行\n@serve'), { kind: 'at', start: 4, end: 10, query: 'serve' })
  assert.equal(atEnd('dev@example.com'), null)
  // 打了空格就是不要这张单子了
  assert.equal(atEnd('看看 @src '), null)
  // 光标在词的中间：只算到光标为止
  assert.deepEqual(findTrigger('@serve.go 这个', 4), { kind: 'at', start: 0, end: 4, query: 'ser' })
  // 选中之后把触发词拿掉：前后的字都留着，后面紧跟的那个空格一起拿掉
  const text = '看看 @src/app 这个'
  assert.deepEqual(cutTrigger(text, findTrigger(text, 11)), { text: '看看 这个', caret: 3 })
  // 它不是对会话办事的命令，算不算“单独成行”和它无关；这里只确认认得出来
  assert.equal(atEnd('看看 @')?.kind, 'at')
})

test('触发词是不是输入框里唯一的东西', () => {
  const alone = (text, caret = text.length) => standsAlone(text, findTrigger(text, caret))
  assert.equal(alone('/new'), true)
  assert.equal(alone('  \n/new'), true)
  assert.equal(alone('写了一半\n/new'), false)
  // 光标后面还有字
  assert.equal(alone('/new\n后面还有', 4), false)
})

test('把触发词拿掉：别的字原样留着，光标落在它原来的位置', () => {
  const cut = (text, caret = text.length) => cutTrigger(text, findTrigger(text, caret))
  assert.deepEqual(cut('/rev'), { text: '', caret: 0 })
  assert.deepEqual(cut('第一行\n/rev'), { text: '第一行\n', caret: 4 })
  // 词后面紧跟的那个空格一起拿掉
  assert.deepEqual(cut('/rev 看这次改动', 4), { text: '看这次改动', caret: 0 })
  // 光标在词中间：只拿掉到光标为止的那一段
  assert.deepEqual(cut('/review', 3), { text: 'view', caret: 0 })
})

test('过滤和排序：开头对上的在前，中间含着的其次，字母按顺序出现的最后；不分大小写', () => {
  const entry = (...words) => ({ words })
  const list = [entry('compact'), entry('code-review'), entry('new'), entry('release-notes')]
  const names = (query) => rank(list, query).map((item) => item.words[0])
  // 没打字：原来的顺序
  assert.deepEqual(names(''), ['compact', 'code-review', 'new', 'release-notes'])
  assert.deepEqual(names('co'), ['compact', 'code-review'])
  // re：release-notes 开头就是，code-review 是中间含着
  assert.deepEqual(names('re'), ['release-notes', 'code-review'])
  assert.deepEqual(names('RE'), ['release-notes', 'code-review'])
  // crv：只有 code-review 里按顺序都有
  assert.deepEqual(names('crv'), ['code-review'])
  assert.deepEqual(names('zzz'), [])
  // 别名、当前语言里的叫法也能对上
  assert.deepEqual(
    rank([entry('new', '开一个新对话'), entry('model', '换模型')], '模型').map(
      (item) => item.words[0],
    ),
    ['model'],
  )
})

test('上下键在单子里走：到头绕回另一头', () => {
  assert.equal(step(3, 0, 1), 1)
  assert.equal(step(3, 2, 1), 0)
  assert.equal(step(3, 0, -1), 2)
  assert.equal(step(0, 0, 1), -1)
})

test('内建命令：做不了的不列；夹在话里的时候一条都不出', () => {
  const all = ['model', 'effort', 'permission']
  const facts = (extra = {}) => ({
    inSession: true,
    canCompact: true,
    plan: false,
    pickers: all,
    alone: true,
    ...extra,
  })
  // 这个 harness 会计划模式才有 /plan
  assert.deepEqual(builtinCommands(facts({ plan: true })).slice(0, 3), ['new', 'compact', 'plan'])
  assert.deepEqual(builtinCommands(facts()), [
    'new',
    'compact',
    'model',
    'effort',
    'permissions',
    'terminal',
  ])
  // 新建对话页：没有会话可以压缩，也已经是新对话了
  assert.deepEqual(builtinCommands(facts({ inSession: false })), [
    'model',
    'effort',
    'permissions',
    'terminal',
  ])
  // 回合在跑、这个会话不会压缩：没有 /compact
  assert.equal(builtinCommands(facts({ canCompact: false })).includes('compact'), false)
  // 底栏上没有的选择器叫不出来
  assert.deepEqual(builtinCommands(facts({ pickers: ['model'] })), [
    'new',
    'compact',
    'model',
    'terminal',
  ])
  assert.deepEqual(builtinCommands(facts({ alone: false })), [])
})
