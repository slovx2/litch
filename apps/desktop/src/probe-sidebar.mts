// 侧栏的验收，对着模拟核心：收起的项目和设备那一行上看得出里面的状况。
// 模拟核心里本机的 litch 项目有一个在跑的、一个等审批的、一个没看过的，docs-site 里有一个没看过的；
// build-01 的 litch 里有一个等回答的；nas 上的都闲着。
// 和别的验收一样，下面带 Seen 的函数会被原样送进页面里执行，不能引用函数外面的东西
// （手是 probe-sidebar-kit.mts 先装好的）；judge 开头的在主进程里跑。编排在 probe-sidebar-run.mts。
import type { SidebarKit } from './probe-sidebar-kit.mjs'

export interface TallySeen {
  /** 展开着的时候：设备那一行、项目那一行上都没有汇总 */
  quietWhenOpen: boolean
  /** 收起本机的 litch：行尾的汇总（等人的小标上的字｜在跑的记号｜没看过的记号｜待审批/待回答/在跑/未读各几个） */
  workspace: string
  /** 读屏听到的那一句 */
  spoken: string
  /** 行上的汇总里有没有写数字 */
  digits: boolean
  /** 这时鼠标停上去，信息卡里的那一行 */
  card: string
  /** 再展开：汇总没了，里面那个等审批的会话自己在 */
  backWhenOpen: boolean
  /** 收起本机：整台设备合起来的；信息卡里的那一行 */
  device: string
  deviceCard: string
  /** 什么事都没有的项目（nas 上的）收起来：没有汇总，信息卡里也没有那一行 */
  idle: string
  /**
   * build-01 的 litch 一直收着，小标一路上写的是什么：
   * 开头（一个等回答的）→ 里面又有一个停下来等审批 → 同意之后
   */
  live: string[]
  /** 行尾的按钮露出来的时候，汇总的右边离最左边那个按钮还有多远。负数就是被盖住了。项目那一行、设备那一行各量一次 */
  clearance: number[]
  /** 设备那一行的按钮露出来时别的小标是藏起来的，汇总里等人的那个不藏 */
  pillKept: boolean
  /** 六套皮肤明暗，项目那一行和设备那一行各量一遍：哪里｜行高差｜横向溢出｜名字露出多宽（没被截断是“全”）｜小标的对比度｜两个记号的大小 */
  skins: string[]
}

export async function tallySeen(): Promise<TallySeen> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one, all, text, until, frame } = kit
  /** 一行上的汇总读成一句：小标上的字｜在跑的记号｜没看过的记号｜四个数。没有汇总就是“没有” */
  const read = (line: Element) => {
    const tally = one('.tally', line)
    if (!tally) return '没有'
    const { approval, answer, running, unread } = tally.dataset
    return [
      text(one('.pill.wait', tally)) || '没有小标',
      one('.st.run', tally) ? '在跑' : '',
      one('.st.unread', tally) ? '未读' : '',
      `${approval}/${answer}/${running}/${unread}`,
    ].join('｜')
  }
  /** 信息卡里说现在状况的那一行：没有就是空的 */
  const fact = async (line: Element, what: string) => {
    const shown = await kit.hover(line, what)
    const row = one('[data-tally]', shown.card)
    const said = row ? `${text(one('dt', row))}：${all('dd > span', row).map(text).join('｜')}` : ''
    await shown.close()
    return said
  }
  await until('侧栏里的会话', () => kit.titles('local').length >= 5 && kit.titles('build').length)
  const WAITING = '聚合面：会话列表合并与复合游标'

  // ---- 一、展开着没有汇总；收起项目就有 ----
  const localLine = kit.deviceLine('local')
  const litch = () => kit.workspaceLine('local', 'litch')
  const quietWhenOpen = all('.tally').length === 0 && Boolean(kit.row(WAITING))
  await kit.fold(litch(), false)
  const mark = await until('收起的项目上的汇总', () => one('.tally', litch()), 5000)
  const workspace = read(litch())
  const spoken = `${mark.getAttribute('role')}：${mark.getAttribute('aria-label')}`
  const digits = /\d/.test(text(mark))
  const card = await fact(litch(), '收起的项目')

  // ---- 二、行尾的按钮露出来（点开“更多”，它和“新建会话”就都露着）：汇总往左让 ----
  const clearance: number[] = []
  let pillKept = false
  const withMenu = async (line: Element, what: string) => {
    const more = await until(`${what}行尾的“更多”`, () =>
      one<HTMLButtonElement>('.row-more > .ibtn', line),
    )
    more.click()
    const pop = await until(`${what}的菜单`, () => one('.row-more .pick-pop', line))
    await frame()
    const buttons = all(':scope > .row-add, :scope > .row-more', line)
    const tally = one('.tally', line) as HTMLElement
    clearance.push(
      Math.round(
        Math.min(...buttons.map((entry) => entry.getBoundingClientRect().left)) -
          tally.getBoundingClientRect().right,
      ),
    )
    pillKept = getComputedStyle(one('.pill.wait', tally) as HTMLElement).visibility === 'visible'
    kit.press(document.activeElement ?? pop, 'Escape')
    await until('菜单收起', () => !pop.isConnected, 5000)
  }
  await withMenu(litch(), '项目')

  // ---- 三、六套皮肤：汇总不把行撑高、不溢出，名字还在，小标看得清 ----
  const plain = () => one('.ws-row', kit.workspaceLine('local', 'docs-site')) as HTMLElement
  const look = (where: string, line: Element, level: HTMLElement) => {
    const button = one('[aria-expanded]', line) as HTMLElement
    const pill = one('.tally .pill.wait', line) as HTMLElement
    const name = one('.name', line) as HTMLElement
    const size = (selector: string) => {
      const box = one(selector, line)?.getBoundingClientRect()
      return box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '没有'
    }
    return [
      where,
      button.offsetHeight - level.offsetHeight,
      button.scrollWidth - button.clientWidth,
      // 名字被截断了才看它还露出多宽：本来就短的名字不算被挤
      name.scrollWidth > name.clientWidth ? name.clientWidth : '全',
      kit.contrast(getComputedStyle(pill).color, kit.backdrop(pill)).toFixed(1),
      `${size('.tally .st.run')}+${size('.tally .st.unread')}`,
    ].join('｜')
  }
  const skins = await kit.eachSkin((where) => look(`项目 ${where}`, litch(), plain()))

  // ---- 四、展开回去；收起整台设备 ----
  await kit.fold(litch(), true)
  const backWhenOpen = !one('.tally', litch()) && Boolean(kit.row(WAITING))
  await kit.fold(localLine, false)
  await until('收起的设备上的汇总', () => one('.tally', localLine), 5000)
  const device = read(localLine)
  const deviceCard = await fact(localLine, '收起的设备')
  await withMenu(localLine, '设备')
  const level = one('.dev-row', kit.deviceLine('build')) as HTMLElement
  skins.push(...(await kit.eachSkin((where) => look(`设备 ${where}`, localLine, level))))
  await kit.fold(localLine, true)

  // ---- 五、什么事都没有的：收起来也没有汇总 ----
  const backup = kit.workspaceLine('nas', 'backup-scripts')
  await kit.fold(backup, false)
  const idle = `${read(backup)}｜${await fact(backup, '闲着的项目')}`
  await kit.fold(backup, true)

  // ---- 六、收着的时候里面有会话停下来等人：行上跟着变 ----
  const remote = () => kit.workspaceLine('build', 'litch')
  const label = () => text(one('.tally .pill.wait', remote()))
  await kit.open('差异面板的大文件降级')
  await kit.fold(remote(), false)
  const live = [read(remote())]
  await kit.say('这一步要一次审批')
  await until('审批卡片', () => one('.req'))
  await until('行上换成两种都有的说法', () => label() !== live[0]?.split('｜')[0], 10_000)
  live.push(read(remote()))
  ;(
    await until('审批卡片上的“同意”', () =>
      one<HTMLButtonElement>('.req .req-actions .btn.primary'),
    )
  ).click()
  await until('这个回合结束', () => !one('.req') && !one('.running-line'), 60_000)
  await until('在跑的记号收掉', () => !one('.tally .st.run', remote()), 10_000)
  live.push(read(remote()))
  await kit.fold(remote(), true)

  return {
    quietWhenOpen,
    workspace,
    spoken,
    digits,
    card,
    backWhenOpen,
    device,
    deviceCard,
    idle,
    live,
    clearance,
    pillKept,
    skins,
  }
}

export function judgeTally(seen: TallySeen): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(seen.quietWhenOpen, '展开着的行上不该有汇总')
  must(
    seen.workspace === '待审批｜在跑｜未读｜1/0/1/1',
    `收起的项目那一行上看不出里面有等审批的、在跑的、没看过的：${seen.workspace}`,
  )
  must(
    seen.spoken === 'img：1 个待审批，1 个在跑，1 个未读',
    `收起的项目上的汇总，读屏听到的不对：${seen.spoken}`,
  )
  must(!seen.digits, '行上的汇总里写了数目（数目该在信息卡里）')
  must(
    seen.card === '现在：1 个待审批｜1 个在跑｜1 个未读',
    `项目的信息卡里没有写里面各有几个：${seen.card}`,
  )
  must(seen.backWhenOpen, '项目展开回去之后汇总还在，或者里面等审批的会话没画出来')
  must(
    seen.device === '待审批｜在跑｜未读｜1/0/1/2',
    `收起的设备那一行上的汇总不对：${seen.device}`,
  )
  must(
    seen.deviceCard === '现在：1 个待审批｜1 个在跑｜2 个未读',
    `设备的信息卡里没有写下面各有几个：${seen.deviceCard}`,
  )
  must(seen.idle === '没有｜', `什么事都没有的项目收起来不该有汇总：${seen.idle}`)
  must(
    seen.live.join(' → ') === '待回答｜｜｜0/1/0/0 → 等你处理｜｜｜1/1/0/0 → 待回答｜｜｜0/1/0/0',
    `项目收着的时候里面有会话停下来等审批，行上没有跟着变：${seen.live.join(' → ')}`,
  )
  must(
    seen.clearance.length === 2 && seen.clearance.every((gap) => gap >= 2),
    `行尾的按钮露出来的时候盖住了汇总（项目、设备各差 ${seen.clearance.join('、')} 像素）`,
  )
  must(seen.pillKept, '设备行尾的按钮露出来的时候，汇总里等人的小标被藏起来了')
  for (const line of seen.skins) {
    const [where, taller, over, name, contrast, marks = ''] = line.split('｜')
    must(taller === '0', `${where} 下带汇总的那一行比别的行高了 ${taller} 像素`)
    must(over === '0', `${where} 下带汇总的那一行横向溢出了 ${over} 像素`)
    must(name === '全' || Number(name) >= 40, `${where} 下汇总把名字挤没了（只露出 ${name} 像素）`)
    must(Number(contrast) >= 3, `${where} 下等人的小标和底色分不开（对比度 ${contrast}）`)
    must(
      marks.split('+').every((size) => {
        const [width = 0, height = 0] = size.split('x').map(Number)
        return width >= 6 && height >= 6
      }),
      `${where} 下在跑的、没看过的记号没画出来：${marks}`,
    )
  }
  must(seen.skins.length === 12, `皮肤没有量全：${seen.skins.length}`)
  return failed
}
