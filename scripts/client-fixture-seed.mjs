// 隔离入口里造哪些会话。内容全是编的，目的是把对话区要处理的几种情况都摆出来：
// 很长的对话、带思考和工具调用的回合、一个回合里上百次工具调用、不属于任何工作区的会话。
import { join } from 'node:path'

const LONG_TURNS = 24
const MANY_CALLS = 120

/** 一段像样的长回答：有段落、列表、代码块，长度随序号变化 */
function longAnswer(index) {
  const parts = [
    `第 ${index + 1} 轮的结论先说：这一步可以做，改动集中在连接层，不影响已有的入口。`,
    '',
    '具体分三件事：',
    '',
    '1. 把“开传输”和“握手”拆成两个阶段，各自有超时，失败时带上是哪个阶段。',
    '2. 断线之后按退避重连，连上以后计数清零；要人处理的失败（没装、版本太低）不自动重试。',
    '3. 重连成功后做一次全量对账，对账期间到达的通知先攒着，对账完再处理。',
    '',
  ]
  if (index % 3 === 0) {
    parts.push(
      '下面是状态机的骨架：',
      '',
      '```ts',
      'type LinkState =',
      "  | { phase: 'idle' }",
      "  | { phase: 'connecting'; attempt: number }",
      "  | { phase: 'handshaking'; attempt: number }",
      "  | { phase: 'connected' }",
      "  | { phase: 'waiting'; attempt: number; retryAt: number }",
      "  | { phase: 'failed' }",
      '```',
      '',
    )
  }
  for (let extra = 0; extra < index % 4; extra++) {
    parts.push(
      `补充说明 ${extra + 1}：这里要注意的是顺序。先改状态再发通知，界面看到的永远是一致的一份；` +
        '反过来的话，中间会有一帧既不是旧的也不是新的。这一条在流式输出时尤其明显，' +
        '因为同一帧里可能到达好几段文本，必须合并之后一次交给界面。',
      '',
    )
  }
  parts.push('还有问题的话接着问，我会在同一个会话里继续。')
  return parts.join('\n')
}

export async function seedSessions({ call, waitFor, replies, dirs }) {
  /** 跑一个回合：先把假模型要回的内容排进队列，再发起回合，等它结束 */
  const turn = async (threadId, text, scripted) => {
    replies.push(...scripted)
    const done = waitFor(
      (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
    )
    await call('turn/start', { threadId, input: [{ type: 'text', text }] })
    const completed = await done
    const status = completed.params.turn.status
    if (status !== 'completed') throw new Error(`回合没有正常结束：${status}`)
  }
  const start = async (cwd, name) => {
    const { thread } = await call('thread/start', { cwd, model: 'gate/gate' })
    if (name) await call('thread/name/set', { threadId: thread.id, name })
    return thread.id
  }

  await call('project/create', {
    name: 'app',
    roots: [{ path: dirs.app }],
    idempotencyKey: 'fixture-app',
  })

  // 一、很长的对话，用来看滚动
  const long = await start(dirs.app, '连接层的重连与对账')
  for (let index = 0; index < LONG_TURNS; index++) {
    await turn(long, `第 ${index + 1} 个问题：重连之后的对账该怎么做？请分点说。`, [
      { text: longAnswer(index) },
    ])
  }

  // 二、带思考、命令、写文件的回合。工作目录是工作区的子目录
  const tools = await start(dirs.web, '给首页加一个状态条')
  await turn(tools, '在 web 目录下加一个 status.txt，写上当前状态，然后确认一下。', [
    {
      thinking: ['先看目录里有什么。', '再写文件，最后读回来核对。'],
      tools: [{ name: 'bash', args: { command: 'ls -la' } }],
    },
    {
      tools: [
        {
          name: 'write',
          args: { path: join(dirs.web, 'status.txt'), content: '状态：正常\n更新：刚刚\n' },
        },
      ],
    },
    { tools: [{ name: 'bash', args: { command: 'cat status.txt && wc -l status.txt' } }] },
    { text: '文件已经写好并核对过了：`status.txt` 两行，内容是状态和更新时间。' },
  ])
  await turn(tools, '再把“刚刚”改成具体的日期。', [
    {
      tools: [
        {
          name: 'write',
          args: { path: join(dirs.web, 'status.txt'), content: '状态：正常\n更新：2026-10-12\n' },
        },
      ],
    },
    { text: '改好了，更新时间现在是 2026-10-12。' },
  ])

  // 三、一个回合里上百次工具调用
  const many = await start(dirs.app, '逐个检查一百多个文件')
  await turn(many, `依次检查 ${MANY_CALLS} 个编号，每个都要单独跑一次命令。`, [
    ...Array.from({ length: MANY_CALLS }, (_, index) => ({
      tools: [{ name: 'bash', args: { command: `echo 检查编号 ${index + 1}：通过` } }],
    })),
    { text: `${MANY_CALLS} 个编号都检查过了，全部通过。` },
  ])

  // 四、不属于任何工作区的会话，没有起名字
  const loose = await start(dirs.notes, null)
  await turn(loose, '帮我想三个周报的小标题。', [
    { text: '可以用这三个：\n\n- 本周做完的\n- 卡住的和原因\n- 下周打算做的' },
  ])
}
