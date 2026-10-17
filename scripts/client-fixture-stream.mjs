// 隔离环境里的“长回答”：给移动端的流畅度测试用（research/mobile-prototype-2026-10-17）。
// 用户的话里带下面的记号时，假模型吐一段内容固定的长 Markdown（段落、列表、行内代码、代码块、表格、引用轮着来），
// 小块、匀速地发，界面上是一段持续很久的流式输出。内容只由记号决定，同一个记号每次吐的字一模一样，
// 新旧两个客户端拿到的输入才可比。
//   长回答        约 60 秒，每 50 毫秒一块、每块 24 个字
//   长回答三倍    同样的内容，每 50 毫秒一块、每块 72 个字（约 20 秒）
//   十万字        十万字左右，一次发完（造“进入很长的会话”的历史用）
//   短回答        一两段（造很多轮的历史用）
//   五十步        一次调用五十条无害的命令（echo），再说一句话：造一个五十步的过程组
// 每种也认一个英文写法（LONG_X3、LONG_ANSWER、HUGE_ANSWER、SHORT_ANSWER、MANY_STEPS）：Maestro 在安卓上输不了中文，对照组的旧客户端靠它打字

const SECTIONS = 230

function section(index) {
  const n = index + 1
  switch (index % 6) {
    case 0:
      return [
        `## 第 ${n} 节：流式输出的稳定性`,
        '',
        `这是第 ${n} 段说明文字，用来让对话区持续变高。Streaming text should stay pinned to the bottom ` +
          `while new lines arrive, and the last line must never hide behind the composer. ` +
          `中文和 English 混排，带一个 \`inline-code-${n}\`，再带一点 **粗体** 和 *斜体*。`,
      ].join('\n')
    case 1:
      return [
        `### 要点 ${n}`,
        '',
        `- 第一条：行身份在流式和定稿之间不变（${n}）`,
        '- 第二条：增量只更新对应的条目，不重排整张表',
        '- 第三条：正在看的那一轮完成时不自动收起',
        `  - 嵌套的一条，编号 ${n}`,
      ].join('\n')
    case 2:
      return [
        `下面是一段代码（${n}）：`,
        '',
        '```ts',
        `export function frame${n}(items: string[]): number {`,
        '  let total = 0',
        '  for (const item of items) {',
        '    total += item.length',
        '  }',
        `  return total * ${n}`,
        '}',
        '```',
      ].join('\n')
    case 3:
      return [
        `| 指标 ${n} | 目标 | 说明 |`,
        '| --- | --- | --- |',
        '| 贴底偏差 | ≤ 2dp | 99% 的帧 |',
        '| 卡顿帧 | ≤ 3% | 流式 60 秒 |',
        `| 编号 | ${n} | 用来区分各节 |`,
      ].join('\n')
    case 4:
      return [
        `> 引用 ${n}：内容增长时，已经显示出来的部分不应该上下晃动。`,
        '>',
        '> 第二行引用，长一点，好让它在窄屏上折成两到三行，测一测折行的时候高度变化是不是平滑的。',
      ].join('\n')
    default:
      return [
        `${n}. 编号列表的第一项`,
        `${n + 1}. 编号列表的第二项，带链接 [litch](https://example.invalid/${n})`,
        `${n + 2}. 编号列表的第三项`,
      ].join('\n')
  }
}

/** 五十步：一组过程的步数，和命令里认自己用的记号 */
const STEPS = 50
const STEP_MARK = 'litch-step'

/** 长回答的全文：同一个调用每次返回同一段字 */
export function longText(sections = SECTIONS) {
  return Array.from({ length: sections }, (_, index) => section(index)).join('\n\n')
}

/** 十万字左右的全文 */
export function hugeText() {
  const parts = []
  let length = 0
  for (let index = 0; length < 100_000; index++) {
    const part = section(index)
    parts.push(part)
    length += part.length + 2
  }
  return parts.join('\n\n')
}

/**
 * 认得出是不是要长回答，是就给出回复（text、每块多少字、两块之间停多久），不是就返回 null。
 * 先认长的记号：“长回答三倍”里也有“长回答”
 */
export function streamReply(body, said) {
  if (typeof said !== 'string') return null
  const messages = body?.messages ?? []
  if (messages.at(-1)?.role === 'tool') {
    // 只认自己发起的那一批调用的结果
    const asked = messages.findLast((message) => message.role === 'assistant' && message.tool_calls)
    const mine = asked?.tool_calls?.some((call) => (call.function?.arguments ?? '').includes(STEP_MARK))
    return mine ? { text: `${STEPS} 步都跑完了。`, chunk: 40, pace: 20 } : null
  }
  const says = (zh, ascii) => said.includes(zh) || said.includes(ascii)
  if (says('长回答三倍', 'LONG_X3')) return { text: longText(), chunk: 72, pace: 50 }
  if (says('长回答', 'LONG_ANSWER')) return { text: longText(), chunk: 24, pace: 50 }
  if (says('十万字', 'HUGE_ANSWER')) return { text: hugeText(), chunk: 4000, pace: 0 }
  if (says('短回答', 'SHORT_ANSWER')) return { text: `${section(0)}\n\n${section(1)}`, chunk: 40, pace: 20 }
  if (says('五十步', 'MANY_STEPS')) {
    // 一次发起五十条命令（Pi 的 bash 工具），界面上是一组五十步的过程
    return {
      tools: Array.from({ length: STEPS }, (_, index) => ({
        name: 'bash',
        args: { command: `echo ${STEP_MARK}-${index + 1}` },
      })),
    }
  }
  return null
}
