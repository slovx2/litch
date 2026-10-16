// 远程设备第二遍验收的后一半（前一半和总的说明在 probe-remote-service.mts）：
// 在远程设备服务上新建会话、发消息、回合中断线自己连回来；在远程设备上开终端、断线后接回。
// 对面变了自己换过去、各种没连上的说法在 probe-remote-service-ends.mts。
// 断线是真的断：页面打一行 LITCH_SIGNAL drop，起自检的脚本把应用起的那几条 ssh 结束掉。
import type { TerminalKit } from './probe-terminal-kit.mjs'

export interface ServiceSession {
  /**
   * 新建对话页：换到远程设备和它的工作区之后，页上说了会建在哪个 harness 上（标题栏的徽标）。
   * 假机器上可用的只有 Pi 一个，所以没有选 harness 的选择器：可用的不止一个才出，和本机一样
   * （选择器本身在 check:full 里量）。pickerShown 照实记下来
   */
  target: string
  pickerShown: boolean
  /** 换过去之后页上不该再说“建不了” */
  stillBlocked: string
  /** 建在远程设备上的新会话：回话带着发的那一句，落在选的工作区里，徽标是选的那个 harness */
  created: boolean
  inWorkspace: boolean
  badge: string
  crumb: string
  /** 回合进行中把 ssh 断掉：设备显示成没连着，随后自己连回来，那个回合的回话完整到了界面上 */
  dropped: boolean
  recovered: boolean
  turnSurvived: boolean
  sentAfter: boolean
  /** 在远程设备上开终端：是设备上的终端（没标“随连接结束”），敲的命令有结果 */
  terminalOpened: boolean
  ephemeral: boolean
  echoed: boolean
  /** 断线：标签说没连上，状态条说它还在设备上；连回来自己接上，之前的内容还在，期间的输出正好出现一次 */
  awayNote: string
  rejoined: boolean
  earlierKept: boolean
  replayedOnce: boolean
  usable: boolean
  /** 收尾时让 shell 自己退出之后，标签的状态 */
  ended: string
}

/** opening：新会话的头一句，也是它的标题（后面按它在别的设备下找这个会话） */
export async function serviceSession(svc: string, opening: string): Promise<ServiceSession> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, all, text, frame } = kit
  const write = (target: HTMLTextAreaElement, words: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      target,
      words,
    )
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const group = (name: string) =>
    all('.dev-group').find((element) => text(one('.dev-row .name', element)) === name)
  const online = (name: string) => {
    const element = group(name)
    return Boolean(element && !element.classList.contains('off'))
  }
  const area = () => one<HTMLTextAreaElement>('textarea.cmp-text')
  const say = async (words: string) => {
    const input = await until('输入框', area)
    write(input, words)
    await frame()
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await frame()
  }
  const lastTurn = () => all('.turn').at(-1)?.textContent ?? ''
  const running = () => Boolean(one('.running-line'))
  const settled = (words: string) => lastTurn().includes(`收到：${words}`) && !running()
  const picker = (kind: string) => one<HTMLButtonElement>(`.pick[data-kind="${kind}"] .pick-btn`)
  const options = (kind: string) => all(`.pick[data-kind="${kind}"] .pick-opt`)
  /** 点开一个选择器，选标题是这几个字的那一项 */
  const choose = async (kind: string, title: string) => {
    if (text(picker(kind)) === title) return
    ;(await until(`“${kind}”的选择器`, () => picker(kind))).click()
    const option = await until(`“${kind}”里的“${title}”`, () =>
      options(kind).find((entry) => text(one('b', entry)) === title),
    )
    option.click()
    await until(`“${kind}”换成“${title}”`, () => text(picker(kind)) === title)
    await frame()
  }

  // ---- 一、新建对话页：设备换成远程的那台，工作区选刚加的 ----
  ;(await until('侧栏最上面的“新对话”', () => one<HTMLButtonElement>('.sb-link.new'))).click()
  await until('新建对话页', () => one('.new-hero') && picker('device'))
  await choose('device', svc)
  await choose('workspace', '远程区')
  // 建在哪个 harness 上：标题栏的徽标说的是那台机器的设备服务上可用的那一个
  const chip = await until('标题栏上的徽标', () => one<HTMLElement>('.crumb .chip'), 30_000)
  const target = chip.title
  const pickerShown = Boolean(picker('harness'))
  await frame()
  const stillBlocked = `${text(one('.new-why'))}${text(one('.dock .cmp-hint.err'))}`

  // ---- 二、发头一句：会话建在那台机器上，回话是那边的假模型说的 ----
  await say(opening)
  await until(
    '落到新会话里',
    () => !one('.new-hero') && text(one('.ss-row.sel')).includes(opening),
    60_000,
  )
  await until('头一句的回话', () => settled(opening), 90_000)
  const created = true
  const row = one('.ss-row.sel') as HTMLElement
  const zone = all('[data-workspace]', group(svc) as HTMLElement).find(
    (line) => text(one('.name', line)) === '远程区',
  )
  const inWorkspace =
    Boolean(zone) &&
    row.closest<HTMLElement>('[data-group]')?.dataset.group === zone?.dataset.workspace
  const badge = one('.chip', row)?.title ?? ''
  const crumb = `${text(one('.crumb .dev'))}/${text(one('.crumb span.ell'))}`

  // ---- 三、回合进行中断线：自己连回来，回合不丢 ----
  const during = '断线的时候在说的这一句'
  await say(during)
  await until('回话开始输出', () => (one('.md.live')?.textContent?.length ?? 0) > 0, 60_000)
  kit.signal('drop')
  await until('设备显示成没连着', () => !online(svc), 30_000)
  const dropped = true
  await until('自己连回来', () => online(svc), 90_000)
  const recovered = true
  // 假模型把话分成几段慢慢发，最后一段的末尾是固定的。等到整段都在、回合结束
  await until(
    '断线时那个回合的回话完整到达',
    () => {
      const words = lastTurn()
      return words.includes(`收到：${during}`) && words.includes('一点一点出来的') && !running()
    },
    90_000,
  )
  const turnSurvived = true
  const after = '连回来之后的一句'
  await say(after)
  await until('连回来之后的回话', () => settled(after), 90_000)
  const sentAfter = true

  // ---- 四、在远程设备上开终端：它是那台机器的设备服务管着的，ssh 断了也还在 ----
  kit.toggle()
  await until('面板打开', () => kit.panelOpen())
  await until('顺手开出一个终端', () => kit.tabs().length === 1, 60_000)
  await until('终端起来了', () => kit.tabs()[0]?.state === 'running', 60_000)
  await kit.calm()
  await kit.prompt(60_000)
  const terminalOpened = true
  const ephemeral = Boolean(one('.term-eph'))
  // 记号写成算式：敲进去的那一行里没有结果的字样，屏幕上出现了就一定是那边的 shell 打出来的
  kit.run('echo Hello-$((40+2))')
  await kit.see('echo 的结果', /\nHello-42/, 30_000)
  await kit.prompt()
  const echoed = kit.rows().includes('Hello-42')
  // 先打一个记号再睡：看到记号，说明这一行命令对面已经收下、在跑了，这时候再断线
  kit.run('echo go-$((1+1)); sleep 4; echo after-drop-$((6*7))')
  await kit.see('命令跑起来了', /\ngo-2/, 30_000)
  kit.signal('drop')
  await until('标成没连上', () => kit.tabs()[0]?.state === 'away', 30_000)
  const awayNote = text(one('.term-status[data-state="away"]'))
  await until('接回来了', () => kit.tabs()[0]?.state === 'running', 90_000)
  await kit.see('断线前后的输出都在', /\nafter-drop-42/, 60_000)
  await kit.prompt()
  const rejoined = !one('.term-status')
  const earlierKept = kit.rows().includes('Hello-42') && kit.rows().includes('go-2')
  const replayedOnce = kit.screen().split('\nafter-drop-42').length === 2
  kit.run('echo still-$((1+1))')
  await kit.see('还能接着用', /\nstill-2/, 30_000)
  await kit.prompt()
  const usable = true
  // 收尾：让 shell 自己退出，不在那台“机器”上留一个开着的终端
  kit.run('exit')
  await kit.seen(() => kit.tabs()[0]?.state !== 'running', 30_000)
  const ended = kit.tabs()[0]?.state ?? '没有标签了'
  if (kit.panelOpen()) kit.toggle()
  await kit.seen(() => !kit.panelOpen())

  return {
    target,
    pickerShown,
    stillBlocked,
    created,
    inWorkspace,
    badge,
    crumb,
    dropped,
    recovered,
    turnSurvived,
    sentAfter,
    terminalOpened,
    ephemeral,
    echoed,
    awayNote,
    rejoined,
    earlierKept,
    replayedOnce,
    usable,
    ended,
  }
}
