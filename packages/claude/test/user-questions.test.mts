import assert from 'node:assert/strict'
import test from 'node:test'
import { projectNativeHistory } from '../src/native-history.mjs'
import { normalizeUserInputAnswers, userInputAnswersAsContent } from '../src/server-helpers.mjs'
import {
  answerText,
  askAnswerContent,
  askUserQuestionUpdatedInput,
  PLAN_NOT_CONFIRMED,
  parseAskUserQuestions,
  planExitQuestion,
  planExitVerdict,
  planWithNote,
} from '../src/user-questions.mjs'

// 提问的桥接：模型出的题怎么变成协议里的题，交回来的答案怎么变成给 CLI 的内容。
// 对着真实 CLI 的端到端用例在 native-interactions.test.mts（QUESTION-001 起）。

const input = {
  questions: [
    {
      question: '归到哪一类？',
      header: '这个题头超过了十二个字符会被截短',
      multiSelect: false,
      options: [
        { label: 'Bug', description: '缺陷', preview: '<b>预览</b>' },
        { label: 'Other', description: '模型自己写的 Other' },
      ],
    },
    {
      question: '要开哪些功能？',
      header: '功能',
      multiSelect: true,
      options: [
        { label: '同步', description: '' },
        { label: '导入, 导出', description: '' },
        { label: '叫 "快照" 的', description: '' },
      ],
    },
    { question: '还有要补充的吗？', header: '补充', multiSelect: false, options: [] },
  ],
}

test('出题：标识按顺序编，选项原样不增不减，“自己说”只用 isOther 表示，多选的标记带不过去', () => {
  const questions = parseAskUserQuestions(input)
  assert.deepEqual(questions, [
    {
      id: 'q0',
      header: '这个题头超过了十二个字符',
      question: '归到哪一类？',
      isOther: true,
      isSecret: false,
      // 模型写的 Other 还是它的选项；预览不在协议的选项里
      options: [
        { label: 'Bug', description: '缺陷' },
        { label: 'Other', description: '模型自己写的 Other' },
      ],
    },
    {
      id: 'q1',
      header: '功能',
      question: '要开哪些功能？',
      isOther: true,
      isSecret: false,
      options: [
        { label: '同步', description: '' },
        { label: '导入, 导出', description: '' },
        { label: '叫 "快照" 的', description: '' },
      ],
    },
    {
      id: 'q2',
      header: '补充',
      question: '还有要补充的吗？',
      isOther: true,
      isSecret: false,
      options: [],
    },
  ])
  assert.deepEqual(parseAskUserQuestions({}), [])
})

test('答案的字：是什么就是什么，不按文字挑拣；空的是没有回答', () => {
  assert.equal(answerText({ answers: ['Bug'] }), 'Bug')
  // 字面的 Other 是一个正经的答案：模型的选项可以叫这个，用户也可以这么写
  assert.equal(answerText({ answers: ['Other'] }), 'Other')
  // 用户自己写的一句话原样，里面的逗号、引号、前缀都不动
  assert.equal(answerText({ answers: ['先 A, 再 "B"'] }), '先 A, 再 "B"')
  assert.equal(answerText({ answers: ['user_note: 备注'] }), 'user_note: 备注')
  // 几个答案（多选）按 CLI 的写法连：逗号加空格，本身带分隔或引号的那一项括起来
  assert.equal(answerText({ answers: ['同步', '导入, 导出'] }), '同步, "导入, 导出"')
  assert.equal(answerText({ answers: ['同步', '叫 "快照" 的'] }), '同步, "叫 \\"快照\\" 的"')
  // 没有回答：没有这道题、空数组、只有空白
  assert.equal(answerText(undefined), '')
  assert.equal(answerText({ answers: [] }), '')
  assert.equal(answerText({ answers: ['', '  '] }), '')
  // 应答里另附的备注（不是标准协议的字段）：没有答案时它就是答案
  assert.equal(answerText({ answers: [], notes: '只写了备注' }), '只写了备注')
  assert.equal(answerText({ answers: ['Bug'], notes: '备注' }), 'Bug')
})

test('交还给 CLI：按题面文字放答案，跳过的给空串，题目原样带回去', () => {
  const questions = parseAskUserQuestions(input)
  const updated = askUserQuestionUpdatedInput(input, questions, {
    answers: {
      q0: { answers: ['Other'] },
      q1: { answers: ['同步', '导入, 导出'], notes: '导出先不急' },
      q2: { answers: [] },
    },
  })
  assert.deepEqual(updated, {
    questions: input.questions,
    answers: {
      '归到哪一类？': 'Other',
      '要开哪些功能？': '同步, "导入, 导出"',
      '还有要补充的吗？': '',
    },
    annotations: { '要开哪些功能？': { notes: '导出先不急' } },
  })
  // 应答里缺了的题和跳过的一样；没有备注就不带 annotations
  const partial = askUserQuestionUpdatedInput(input, questions, {
    answers: { q2: { answers: ['没有了'] } },
  })
  assert.deepEqual(partial.answers, {
    '归到哪一类？': '',
    '要开哪些功能？': '',
    '还有要补充的吗？': '没有了',
  })
  assert.equal('annotations' in partial, false)
  // 只有备注：它已经是答案，不再作为备注重复一遍
  const noted = askUserQuestionUpdatedInput(input, questions, {
    answers: { q0: { answers: [], notes: '都不是' } },
  })
  assert.equal((noted.answers as Record<string, string>)['归到哪一类？'], '都不是')
  assert.equal('annotations' in noted, false)
})

test('应答到条目：客户端回的形状归一后，条目上逐题记着同一份字', () => {
  const questions = parseAskUserQuestions(input)
  // 标准形状；q1 整道题没带（有的客户端跳过时不带这一项）
  const answers = normalizeUserInputAnswers(
    { answers: { q0: { answers: ['Other'] }, q2: { answers: ['写了一句'] } } },
    questions,
  )
  assert.deepEqual(answers, {
    answers: { q0: { answers: ['Other'] }, q1: { answers: [] }, q2: { answers: ['写了一句'] } },
  })
  assert.deepEqual(userInputAnswersAsContent(questions, answers), [
    { type: 'inputText', text: '这个题头超过了十二个字符: Other' },
    { type: 'inputText', text: '功能: (no answer)' },
    { type: 'inputText', text: '补充: 写了一句' },
  ])
})

test('计划确认：选了“执行计划”就放行，带着的话是执行时的补充；只写了话不算确认，原话跟在拒绝后面', () => {
  const question = planExitQuestion()
  assert.equal(question.id, 'execute_plan')
  assert.equal(question.isOther, true)
  assert.deepEqual(
    question.options?.map((option) => option.label),
    ['执行计划', '继续规划'],
  )
  assert.deepEqual(planExitVerdict({ answers: ['执行计划'] }), { execute: true, note: null })
  assert.deepEqual(planExitVerdict({ answers: [' 执行计划 '] }), { execute: true, note: null })
  // 没有确认，也没有话
  for (const slot of [undefined, { answers: [] }, { answers: ['继续规划'] }, { answers: [''] }])
    assert.deepEqual(planExitVerdict(slot), { execute: false, message: PLAN_NOT_CONFIRMED })
  // 只写了话、没选“执行计划”：是对计划的意见，不放行，原话交给模型
  assert.deepEqual(planExitVerdict({ answers: ['先把第二步改成只读检查'] }), {
    execute: false,
    message: `${PLAN_NOT_CONFIRMED}\n用户对这份计划说：\n先把第二步改成只读检查`,
  })
  // 写的正好是 Other：也是一句话，不是没答
  assert.match(
    (planExitVerdict({ answers: ['Other'] }) as { message: string }).message,
    /用户对这份计划说：\nOther$/,
  )
  // 选了“执行计划”又另外带了话：算确认，话是执行时的补充（有的客户端把备注放在答案后面，有的另附）
  assert.deepEqual(planExitVerdict({ answers: ['执行计划', 'user_note: 先备份'] }), {
    execute: true,
    note: 'user_note: 先备份',
  })
  assert.deepEqual(planExitVerdict({ answers: ['执行计划'], notes: '先备份' }), {
    execute: true,
    note: '先备份',
  })
  assert.deepEqual(planExitVerdict({ answers: ['执行计划', '只改文档'], notes: ' 先备份 ' }), {
    execute: true,
    note: '只改文档\n先备份',
  })
  // 两个选项都选了，自相矛盾：不放行，带着的话照样交给模型
  assert.deepEqual(planExitVerdict({ answers: ['执行计划', '继续规划'] }), {
    execute: false,
    message: PLAN_NOT_CONFIRMED,
  })
  assert.deepEqual(planExitVerdict({ answers: ['执行计划', '继续规划'], notes: '再想想' }), {
    execute: false,
    message: `${PLAN_NOT_CONFIRMED}\n用户对这份计划说：\n再想想`,
  })
})

test('确认执行时带的补充并进计划的末尾；还没有成文的计划时补充就是全部', () => {
  assert.equal(
    planWithNote('# 计划\n1. 改代码\n', '先备份'),
    '# 计划\n1. 改代码\n\n## 用户确认执行时的补充\n\n先备份\n',
  )
  for (const empty of [undefined, null, '', '  \n', 42])
    assert.equal(planWithNote(empty, '先备份'), '## 用户确认执行时的补充\n\n先备份\n')
})

test('QUESTION-UNIT-HISTORY：读历史时提问的结果按题面认回答，和实时回合一样每题一行“题头: 回答”；画成动态工具条目', () => {
  const questions = parseAskUserQuestions(input)
  // CLI 写给模型的那句话：答了的题按先后列出，没答的不列；回答里可以有引号、逗号、换行
  const said =
    'User has answered your questions: "归到哪一类？"="Bug", "要开哪些功能？"="同步, "导入, 导出"\n第二行 "引"". You can now continue with these answers in mind.'
  assert.deepEqual(
    askAnswerContent(input, questions, said).map((part) => part.text),
    ['这个题头超过了十二个字符: Bug', '功能: 同步, "导入, 导出"\n第二行 "引"', '补充: (no answer)'],
  )
  // 新版 CLI 的说法，只有一道题
  assert.deepEqual(
    askAnswerContent(
      input,
      questions,
      'The user answered: "还有要补充的吗？"="没有". Read the answers carefully.',
    ).map((part) => part.text),
    ['这个题头超过了十二个字符: (no answer)', '功能: (no answer)', '补充: 没有'],
  )
  // 一道题都认不出来：原样一行
  assert.deepEqual(askAnswerContent(input, questions, '用户拒绝回答'), [
    { type: 'inputText', text: '用户拒绝回答' },
  ])

  const message = (type: string, uuid: string, content: unknown) => ({
    type,
    uuid,
    message: { content },
    timestamp: '2026-10-27T00:00:00Z',
  })
  const { turns } = projectNativeHistory(
    't1',
    [
      message('user', 'u1', '问我'),
      message('assistant', 'a1', [
        { type: 'tool_use', id: 'ask1', name: 'AskUserQuestion', input },
      ]),
      message('user', 'r1', [{ type: 'tool_result', tool_use_id: 'ask1', content: said }]),
      message('assistant', 'a2', [
        { type: 'tool_use', id: 'ask2', name: 'AskUserQuestion', input },
      ]),
    ],
    '/w',
  )
  const [first, second] = (turns[0]?.items ?? []).filter(
    (item) => item.type === 'dynamicToolCall',
  ) as any[]
  assert.equal(first.namespace, 'claude')
  assert.equal(first.tool, 'AskUserQuestion')
  assert.deepEqual(first.arguments, { questions })
  assert.equal(first.status, 'completed')
  assert.deepEqual(first.contentItems, askAnswerContent(input, questions, said))
  // 没等到结果（被打断）的提问：记成失败，不一直“在问”
  assert.equal(second.status, 'failed')
  assert.equal(second.success, false)
})
