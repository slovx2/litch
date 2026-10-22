// 持续目标的验收（对着模拟核心）：由 scripts/smoke.mjs --goal 起（npm run check:goal）。
// 模拟核心照原生 codex 演（packages/core/src/mock/mock-goal.mts）：设下目标后空闲时自己续跑，第三轮报达成。
// 这里照着看：
//   输入框里打 /goal 加一句，不当消息发（没有用户气泡），输入框上方出目标那一行（在做）；
//   续跑回合开头一行“目标未达成，自动继续”，没有用户气泡；
//   达成后那一行马上没了（核心清掉目标），最后一轮的最后一条回答下面写“目标已达成 · 用时 N”，只这一处；
//   再设一个新目标，那一句跟着没了，目标那一行又出来；清除后那一行没了。
// 下面的 goalProbe 会被原样送进页面里执行，不能引用函数外面的东西。

export interface GoalSeen {
  /** 打 /goal 发出去：没画成用户消息，输入框空了 */
  intercepted: boolean
  /** 输入框上方出目标那一行，状态在做，写着目标的话 */
  bar: boolean
  /** 续跑回合开头一行写来历，那个回合没有用户气泡 */
  originLine: boolean
  /** 达成后目标那一行没了 */
  barGone: boolean
  /** 最后一轮的最后一条回答下面写着达成和用时，整段对话只这一处 */
  reachedLine: boolean
  /** 设新目标后达成那一句没了、目标那一行又出来 */
  replaced: boolean
  /** 清除后那一行没了 */
  cleared: boolean
  seen: Record<string, string>
}

export async function goalProbe(sessionId: string): Promise<GoalSeen> {
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
  const until = async (check: () => boolean, ms = 8000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (check()) return true
      await sleep(50)
    }
    return check()
  }
  const $ = <T extends Element = HTMLElement>(selector: string) =>
    document.querySelector<T & HTMLElement>(selector)
  const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
  const seen: Record<string, string> = {}

  await until(() => $(`.row-line[data-session="${sessionId}"]`) !== null, 20000)
  $(`.row-line[data-session="${sessionId}"] .ss-row`)?.click()
  await until(() => $('.main .dock textarea.cmp-text') !== null)
  await sleep(200)
  const box = $<HTMLTextAreaElement>('.main .dock textarea.cmp-text')
  if (!box) throw new Error('找不到输入框')
  const type = async (text: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(80)
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
  const turns = () => $$('.main .turn')
  const before = turns().length
  const userBubbles = () => $$('.main .turn .umsg').length
  const bubblesBefore = userBubbles()

  // —— 设目标 ——
  await type('/goal 整理发版说明')
  const bar = await until(
    () =>
      $('.main .goalbar')?.dataset.goalStatus === 'active' &&
      ($('.main .goalbar .goal-text')?.textContent ?? '') === '整理发版说明',
    4000,
  )
  seen.bar = $('.main .goalbar')?.textContent ?? '没有'
  const intercepted = box.value === '' && userBubbles() === bubblesBefore

  // —— 续跑：每一轮开头一行，没有用户气泡 ——
  const originLine = await until(
    () => $$('.main .turn-origin[data-origin="goal"]').length > 0,
    6000,
  )
  seen.origin = $('.main .turn-origin[data-origin="goal"]')?.textContent ?? '没有'

  // —— 第三轮达成：那一行没了，最后一轮回答下面写用时 ——
  const barGone = await until(() => $('.main .goalbar') === null, 15000)
  await until(() => $('.main .goal-reached') !== null, 4000)
  const reached = $$('.main .goal-reached')
  const last = turns().at(-1)
  const line = reached[0]
  seen.reached = line?.textContent ?? '没有'
  seen.turns = `${before} → ${turns().length}`
  // 用时那一句紧跟在一条回答后面，它后面再没有回答
  const answer = (element: Element | null | undefined) =>
    !!element &&
    (element.matches('[data-anchor^="a:"]') ||
      element.querySelector('[data-anchor^="a:"]') !== null)
  const afterAnswer = answer(line?.previousElementSibling)
  let next = line?.nextElementSibling ?? null
  let laterAnswer = false
  while (next) {
    if (answer(next)) laterAnswer = true
    next = next.nextElementSibling
  }
  const reachedLine =
    reached.length === 1 &&
    line !== undefined &&
    last?.contains(line) === true &&
    afterAnswer &&
    !laterAnswer &&
    /目标已达成 · 用时 \d+ 秒/.test(line.textContent ?? '') &&
    last.querySelector('.turn-origin[data-origin="goal"]') !== null &&
    last.querySelector('.umsg') === null

  // —— 新目标：达成那一句没了；清除后那一行没了 ——
  await type('/goal 再查一遍链接')
  const replaced =
    (await until(() => $('.main .goalbar') !== null && $('.main .goal-reached') === null, 4000)) &&
    ($('.main .goalbar .goal-text')?.textContent ?? '') === '再查一遍链接'
  $('.main .goalbar .goal-act[data-act="clear"]')?.click()
  const cleared = await until(() => $('.main .goalbar') === null, 4000)

  return { intercepted, bar, originLine, barGone, reachedLine, replaced, cleared, seen }
}

const LABELS: Record<Exclude<keyof GoalSeen, 'seen'>, string> = {
  intercepted: '打 /goal 发出去不当消息发：没有用户气泡，输入框空了',
  bar: '输入框上方出目标那一行，状态在做，写着目标的话',
  originLine: '续跑回合开头一行“目标未达成，自动继续”',
  barGone: '达成后目标那一行没了',
  reachedLine: '最后一轮的最后一条回答下面写“目标已达成 · 用时 N”，只这一处',
  replaced: '设新目标后达成那一句没了，目标那一行又出来',
  cleared: '清除后目标那一行没了',
}

export function judgeGoal(seen: GoalSeen): string[] {
  const failed: string[] = []
  for (const [key, label] of Object.entries(LABELS)) {
    if (seen[key as keyof typeof LABELS] !== true) failed.push(label)
  }
  return failed
}
