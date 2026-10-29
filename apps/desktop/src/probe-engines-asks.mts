// 三个引擎各走一遍的验收（二）：审批（批准一次、拒绝一次）和提问。
// 都在眼前这个会话里做（哪个会话由 probe-engines-run.mts 先点开）。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
import type { CardSeen, EnginesKit } from './probe-engines-kit.mjs'
import type { FilesKit } from './probe-files-kit.mjs'

export interface ApprovalSeen {
  /** 发之前底栏的权限选择器选着什么；调到“会问”的那一档之后选着什么（调不了的两个一样） */
  permissionWas: string
  permission: string
  /** 来的那张卡片。没来是 null */
  card: CardSeen | null
  /** 卡片等着的时候，对话里那条命令右边写的是什么 */
  pending: string
  /** 卡片等着的时候侧栏这一行上有没有“等你”的记号 */
  flagged: boolean
  /** 点的是哪个按钮 */
  clicked: string
  /** 回合怎么结束的、回答是什么 */
  foot: string
  answer: string
  /** 这一回合的骨架（做了什么、状态） */
  turn: string[]
  /** 那条命令点开之后里面的输出 */
  output: string
  /** 那条命令右边的几格（连耗时），状态那一格标没标红 */
  meta: string[]
  red: boolean
}

/**
 * 让假模型跑一条命令，卡片来了点 label 那个按钮（“允许这一次”或者“拒绝”）。
 * level 是要先调到的权限档（会问的那一档）；空的就不调
 */
export async function enginesApproval(
  words: string,
  label: string,
  level: string,
): Promise<ApprovalSeen> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  const { one, text, until } = files
  const chosen = () => text(one('.dock .pick[data-kind="permission"] .pick-btn'))

  await kit.idle()
  const permissionWas = chosen()
  if (level && one(`.dock .pick[data-kind="permission"]`)) await kit.pick('permission', level)
  const permission = chosen()

  await kit.send(words)
  const shown = await kit.cardOrEnd()
  const card = shown ? kit.readCard(shown) : null
  // 进行中的步骤组默认收着，那条命令要点开才画出来
  if (shown) await kit.unfold()
  const pending = shown
    ? text(kit.sub(kit.turns().at(-1), '.item-head .meta [data-state="waiting"]'))
    : ''
  // 侧栏的记号和卡片走两条订阅，各按各的帧到，谁先到不一定（流水线上 dsh 卡片先到、记号晚一帧，量空过一次）。
  // 卡片这时一直开着，等记号出现再下结论，不在卡片刚出现的那一帧就读
  const flagged = shown
    ? await until('侧栏这一行上“等你”的记号', () => one('.ss-row.sel .pill.wait'), 5000).then(
        () => true,
        () => false,
      )
    : false
  if (shown) await kit.answer(shown, label)
  await kit.idle()

  const turn = (await kit.outline()).at(-1) ?? []
  // 命令那一条：这一回合里最后一条带输出的
  const last = kit.turns().at(-1)
  const item = kit.subs(last, '.item').findLast((entry) => text(one('.verb', entry)) === '运行')
  const head = kit.sub<HTMLButtonElement>(item, '.item-head')
  if (head?.getAttribute('aria-expanded') === 'false') head.click()
  await files.frame()
  await files.frame()
  return {
    permissionWas,
    permission,
    card,
    pending,
    flagged,
    clicked: shown ? label : '',
    foot: kit.foot(),
    answer: kit.lastAnswer(),
    turn,
    output: text(kit.sub(item, '.item-detail')),
    meta: kit.subs(item, '.item-head .meta > span').map(text),
    red: Boolean(kit.sub(item, '.item-head .meta > .minus')),
  }
}

export interface QuestionSeen {
  /**
   * 先后要答的每一道题：卡片当时的样子，和答的是什么。
   * 一张卡片上有几道题的，一道题记一项（steps 是这张卡片一共几道）
   */
  asked: (CardSeen & { replied: string })[]
  foot: string
  answer: string
  turn: string[]
}

/**
 * 让假模型提问，来了就答：有选项的选第 pick 个（从 0 数），没有的填 typed。
 * 不会提问的 harness 不会来卡片，asked 是空的，回合照常结束
 */
export async function enginesQuestion(
  words: string,
  pick: number,
  typed: string,
): Promise<QuestionSeen> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  const { one, all, text, until, frame, write, press } = files
  /** 眼前这道题：是哪张卡片上的哪一道 */
  const page = () => {
    const card = one('.req')
    return card ? { card, question: text(one('.req-q', card)) } : null
  }

  await kit.idle()
  await kit.send(words)
  const asked: QuestionSeen['asked'] = []
  // 最多答这么多道：对面一直问个不停的话到这里为止，照实报出来
  for (let round = 0; round < 8; round++) {
    const shown = await kit.cardOrEnd()
    if (!shown) break
    const seen = kit.readCard(shown)
    const before = page()
    const options = all('.opt', shown).filter((option) => option.dataset.option !== 'other')
    let replied = ''
    if (options.length > 0) {
      const option = options[Math.min(pick, options.length - 1)]
      replied = text(one('.tx b', option))
      option?.click()
    } else {
      const field = await until('自己填的那一栏', () =>
        one<HTMLInputElement | HTMLTextAreaElement>('.req-input', shown),
      )
      write(field, typed)
      await frame()
      press(field, 'Enter')
      replied = typed
    }
    asked.push({ ...seen, replied })
    // 选了之后隔一小会儿自己往前走：到下一道题，或者交卷（卡片收掉）
    await until(
      '这道题答完往前走',
      () => {
        const now = page()
        return !now || now.card !== before?.card || now.question !== before.question
      },
      30_000,
    )
    await frame()
  }
  await kit.idle()
  return {
    asked,
    foot: kit.foot(),
    answer: kit.lastAnswer(),
    turn: (await kit.outline()).at(-1) ?? [],
  }
}

/**
 * 哪一步走不下去之后收拾眼前的会话，好让后面的步骤接着走：等着的卡片一张张拒掉（跳过），还在跑的回合停下，
 * 输入框清空，计划模式关掉。返回都做了什么
 */
export async function enginesSettle(): Promise<string[]> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  const { one, all, text, frame, sleep, write } = files
  const done: string[] = []
  for (const open of all('dialog[open]')) (open as HTMLDialogElement).close()
  for (const popup of all('.pick-pop')) {
    popup.closest('.pick')?.querySelector<HTMLButtonElement>('.pick-btn')?.click()
  }
  for (let round = 0; round < 10; round++) {
    await sleep(300)
    const card = one('.req')
    if (card) {
      const buttons = all('.req-actions .btn', card)
      const out =
        buttons.find((button) => /拒绝并停止/.test(text(button))) ??
        buttons.find((button) => /^拒绝/.test(text(button))) ??
        one<HTMLButtonElement>('[data-act="skip"]', card)
      done.push(`收掉一张卡片：${text(one('.req-head', card))}`)
      out?.click()
      await files.seen(() => !card.isConnected, 10_000)
      continue
    }
    if (kit.running()) {
      done.push('停下还在跑的回合')
      one<HTMLButtonElement>('.send.stop')?.click()
      await files.seen(() => !kit.running() || one('.req'), 20_000)
      continue
    }
    break
  }
  const input = kit.area()
  if (input?.value) {
    done.push('清空输入框')
    write(input, '')
  }
  for (const cross of all('.dock .cmp-chip-x, .dock .cmp-att-x')) cross.click()
  const plan = one<HTMLButtonElement>('.dock .mode-btn[data-kind="plan"]')
  if (plan?.getAttribute('aria-checked') === 'true') {
    done.push('关掉计划模式')
    plan.click()
  }
  one<HTMLButtonElement>('.plan-ask [data-act="dismiss"]')?.click()
  await frame()
  return done
}
