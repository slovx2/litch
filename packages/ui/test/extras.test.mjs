// 随消息带的东西在输入区里的规矩：技能只带一项；贴进来的文字多长才转成一片、怎么数、怎么放回正文。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  EXTRAS_LIMIT,
  extraLabel,
  fileExtra,
  inlineText,
  lineCount,
  mergeExtras,
  PASTE_CHARS,
  PASTE_LINES,
  pasteVerdict,
  sameExtra,
  TEXT_LIMIT,
  tidyText,
} = await import('../src/composer/extras.ts')

const skill = (name) => ({ kind: 'skill', name, path: `/skills/${name}/SKILL.md` })
const pasted = (text, name = null) => ({ kind: 'text', name, text })

test('技能一条消息只带一项：后选的换掉先选的；同一项再选一遍还是一项', () => {
  assert.deepEqual(mergeExtras([], [skill('review')]), [skill('review')])
  assert.deepEqual(mergeExtras([skill('review')], [skill('review')]), [skill('review')])
  assert.deepEqual(mergeExtras([skill('review')], [skill('notes')]), [skill('notes')])
  assert.equal(sameExtra(skill('review'), skill('review')), true)
  assert.equal(sameExtra(skill('review'), skill('notes')), false)
  assert.equal(extraLabel(skill('review')), '/review')
})

test('贴进来的文字：过了两千个字符或者三十行才转成一片，再长到带不上的不收', () => {
  assert.equal(pasteVerdict('短短一句'), 'inline')
  assert.equal(pasteVerdict('字'.repeat(PASTE_CHARS)), 'inline')
  assert.equal(pasteVerdict('字'.repeat(PASTE_CHARS + 1)), 'attach')
  // 行数：正好三十行还进输入框，多一行就转；末尾的空行不算
  const lines = (n) => Array.from({ length: n }, (_, at) => `第 ${at + 1} 行`).join('\n')
  assert.equal(pasteVerdict(lines(PASTE_LINES)), 'inline')
  assert.equal(pasteVerdict(`${lines(PASTE_LINES)}\n\n`), 'inline')
  assert.equal(pasteVerdict(lines(PASTE_LINES + 1)), 'attach')
  assert.equal(pasteVerdict('x'.repeat(TEXT_LIMIT)), 'attach')
  assert.equal(pasteVerdict('x'.repeat(TEXT_LIMIT + 1)), 'long')
})

test('行数按换行数：各家系统的换行先统一，空的是零行', () => {
  assert.equal(lineCount(''), 0)
  assert.equal(lineCount('\n\n'), 0)
  assert.equal(lineCount('一行'), 1)
  assert.equal(lineCount('一\n二\n\n四'), 4)
  assert.equal(tidyText('一\r\n二\r三\n四'), '一\n二\n三\n四')
  assert.equal(lineCount(tidyText('一\r\n二\r三')), 3)
})

test('带着的文字：贴几次带几段，和技能互不相干；片上的名字没有就交给界面去说', () => {
  const log = pasted('第一段')
  assert.deepEqual(mergeExtras([log], [log]), [log, log])
  assert.deepEqual(mergeExtras([log], [skill('review')]), [skill('review'), log])
  assert.deepEqual(mergeExtras([skill('review'), log], [skill('notes')]), [skill('notes'), log])
  assert.equal(extraLabel(log), null)
  assert.equal(extraLabel(pasted('内容', 'trace.txt')), 'trace.txt')
  assert.equal(sameExtra(log, pasted('第一段')), true)
  assert.equal(sameExtra(log, pasted('第二段')), false)
  assert.equal(sameExtra(log, skill('review')), false)
  // 超出上限的不要
  const many = Array.from({ length: EXTRAS_LIMIT + 3 }, (_, at) => pasted(`第 ${at} 段`))
  assert.equal(mergeExtras([], many).length, EXTRAS_LIMIT)
})

test('放回正文：接在打的字后面空一行，和发出去时并回正文的样子一致；没打字就只有那一段', () => {
  const log = pasted('日志\n第二行')
  assert.equal(inlineText('看看哪里错了', log), '看看哪里错了\n\n日志\n第二行')
  assert.equal(inlineText('看看哪里错了\n\n', pasted('日志')), '看看哪里错了\n\n日志')
  assert.equal(inlineText('', pasted('日志')), '日志')
  assert.equal(inlineText('  \n', pasted('日志')), '日志')
  // 有名字的那一段是一个文件的内容：前面有一行名字
  assert.equal(inlineText('看看', pasted('# 备忘', 'notes.md')), '看看\n\nnotes.md:\n# 备忘')
})

test('提到的文件：同一个不提两遍，片上写的是名字', () => {
  const file = (path) => ({ kind: 'file', name: path.split('/').pop(), path })
  assert.deepEqual(mergeExtras([file('src/app.ts')], [file('src/app.ts'), file('docs/app.ts')]), [
    file('src/app.ts'),
    file('docs/app.ts'),
  ])
  assert.equal(extraLabel(file('src/app.ts')), 'app.ts')
  assert.equal(sameExtra(file('src/app.ts'), skill('review')), false)
  // 和技能、文字互不相干
  assert.deepEqual(mergeExtras([file('a'), pasted('一')], [skill('review')]), [
    skill('review'),
    file('a'),
    pasted('一'),
  ])
})

test('文件面板交过来的文件变成一片：在工作目录里面写相对的，不在里面写完整的，目录带斜杠', async () => {
  const { pathTwin } = await import('../../core/src/text/paths.mts')
  const file = (full, dir = false) => ({ full, dir })
  assert.deepEqual(fileExtra(file('/work/app/src/main.ts'), '/work/app'), {
    kind: 'file',
    name: 'main.ts',
    path: 'src/main.ts',
  })
  assert.deepEqual(fileExtra(file('/work/app/docs', true), '/work/app/'), {
    kind: 'file',
    name: 'docs/',
    path: 'docs/',
  })
  // 工作目录是工作区下面的一层：它外面的文件写完整的路径，harness 才找得到
  assert.deepEqual(fileExtra(file('/work/app/README.md'), '/work/app/packages/ui'), {
    kind: 'file',
    name: 'README.md',
    path: '/work/app/README.md',
  })
  // 名字只是开头像：不算在里面
  assert.equal(fileExtra(file('/work/app-old/a.ts'), '/work/app').path, '/work/app-old/a.ts')
  // 还没有工作目录
  assert.equal(fileExtra(file('/work/app/a.ts'), null).path, '/work/app/a.ts')
  // 文件和工作目录是同一个目录的两种写法（macOS 上 /private/var 和 /var）：给了另一种写法就照样写相对的。
  // 另一种写法由核心按设备的系统给（这里直接用核心的那份，它不引别的文件，Node 读得了）
  const twin = pathTwin('macos')
  assert.equal(
    fileExtra(file('/private/var/w/app/src/main.ts'), '/var/w/app', twin).path,
    'src/main.ts',
  )
  assert.equal(fileExtra(file('/var/w/app/docs', true), '/private/var/w/app', twin).path, 'docs/')
  // 对不上的还是写完整的、原来的那种写法；不给就只比字面
  assert.equal(
    fileExtra(file('/private/var/w/other/a.ts'), '/var/w/app', twin).path,
    '/private/var/w/other/a.ts',
  )
  assert.equal(
    fileExtra(file('/private/var/w/app/a.ts'), '/var/w/app').path,
    '/private/var/w/app/a.ts',
  )
  // 和打 @ 选中的同一个文件是同一片
  assert.equal(
    sameExtra(fileExtra(file('/work/app/src/main.ts'), '/work/app'), {
      kind: 'file',
      name: 'main.ts',
      path: 'src/main.ts',
    }),
    true,
  )
})
