// 侧栏验收里“只看某几个 harness”那一半量到的东西，哪些算不合格。在主进程里跑。
import type { FilterKept, FilterSeen } from './probe-sidebar-filter.mjs'

/** 一行会话读成的那一句（标题｜徽标｜等人｜选中）拆开 */
const parse = (row: string) => {
  const [title = '', badge = '', waiting = '', picked = ''] = row.split('｜')
  return { title, badge, waiting: waiting !== '', picked: picked !== '' }
}
const titlesOf = (rows: string[] | undefined) => (rows ?? []).map((row) => parse(row).title)

// 模拟核心示例数据里的几个会话
const PI_UNREAD = 'Pi 入口过早上报最终回答'
const PI_PINNED = '文档站的待办汇总'
/** Pi 的，在 docs-site 里排得靠后：没筛的时候收在“展示更多”后面 */
const PI_FOLDED = '站内搜索的中文分词'
const CLAUDE_WAITING = '聚合面：会话列表合并与复合游标'
const CLAUDE_RUNNING = '把运行时与 SSH 入口的启动拆开'
const CLAUDE_PINNED = '发版前的检查清单'
const BUILD_ASKING = 'Linux 安装包：systemd 用户服务'
const BUILD_PI = '跑一遍官方桌面端请求回放'

export function judgeFilter(seen: FilterSeen, kept: FilterKept, session: string): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }

  // ---- 入口 ----
  must(seen.entry && seen.quietAtStart, '没筛的时候：筛选的入口不在，或者已经写着“只看”了')
  must(
    seen.options.join() === ',claude,pi,dsh,codex,opencode',
    `筛选能挑的不对（该是全部，加连着的设备上的五个 harness）：${seen.options.join()}`,
  )
  must(
    seen.chosenAtStart === '' && seen.focusAtStart === '',
    `没筛的时候点开入口，选中的、焦点落在的不是“全部”：${seen.chosenAtStart}、${seen.focusAtStart}`,
  )
  must(seen.escaped, '筛选的选项按 Esc 没有收起，或者焦点没有回到入口上')

  // ---- 筛之前 ----
  const localBefore = titlesOf(seen.before.local)
  must(
    [PI_UNREAD, PI_PINNED, CLAUDE_WAITING, CLAUDE_RUNNING, CLAUDE_PINNED, session].every((title) =>
      localBefore.includes(title),
    ) && !localBefore.includes(PI_FOLDED),
    `没筛的时候本机下面的会话不对：${localBefore.join('、')}`,
  )
  must(
    new Set((seen.before.local ?? []).map((row) => parse(row).badge)).size >= 3,
    '没筛的时候本机下面该有好几个 harness 的会话',
  )
  must(seen.moreBefore, '没筛的时候 docs-site 该有“展示更多”')

  // ---- 只看 Pi ----
  must(seen.line === 'PI｜只看 Pi', `“正在只看”那一行写的不对：${seen.line}`)
  must(seen.stayed, '挑了 Pi 之后选项就收起了：多选该能接着挑')
  must(seen.entryOn, '筛着的时候入口没有画成开着的')
  must(seen.saved === 'pi', `挑的 harness 没有记在界面本地：${seen.saved}`)
  for (const [deviceId, rows] of Object.entries(seen.after)) {
    // 留下的只有三种：Pi 的、停下来等人的、正开着的
    const strays = rows
      .map(parse)
      .filter((row) => row.badge !== 'PI' && !row.waiting && !row.picked)
    must(
      strays.length === 0,
      `只看 Pi 的时候 ${deviceId} 下面还画着别的 harness 的会话：${strays.map((row) => row.title).join('、')}`,
    )
    // 筛之前就画着的 Pi 的会话一个不少
    const lost = (seen.before[deviceId] ?? [])
      .map(parse)
      .filter((row) => row.badge === 'PI' && !titlesOf(rows).includes(row.title))
    must(
      lost.length === 0,
      `只看 Pi 的时候 ${deviceId} 下面少了 Pi 的会话：${lost.map((row) => row.title).join('、')}`,
    )
  }
  const local = (seen.after.local ?? []).map(parse)
  const localTitles = local.map((row) => row.title)
  must(
    localTitles.join('、') ===
      [
        PI_PINNED,
        CLAUDE_WAITING,
        PI_UNREAD,
        '能力矩阵页改成从声明生成',
        session,
        '给每个命令补一个最短示例',
        PI_FOLDED,
      ].join('、'),
    `只看 Pi 的时候本机下面的会话不对：${localTitles.join('、')}`,
  )
  must(
    local.some((row) => row.title === CLAUDE_WAITING && row.badge === 'CC' && row.waiting),
    '只看 Pi 的时候，Claude Code 那个等审批的会话不该被筛掉',
  )
  must(
    local.some((row) => row.title === session && row.badge === 'CC' && row.picked),
    '只看 Pi 的时候，正开着的那个会话不该被筛掉',
  )
  must(
    titlesOf(seen.after.build).join('、') === [BUILD_ASKING, BUILD_PI].join('、'),
    `只看 Pi 的时候 build-01 下面的会话不对：${titlesOf(seen.after.build).join('、')}`,
  )
  must(
    titlesOf(seen.after.gpu).join('、') === '评测脚本并行化',
    `只看 Pi 的时候没连着的 gpu-box 下面的会话不对：${titlesOf(seen.after.gpu).join('、')}`,
  )

  // ---- 各组：置顶、分区、无项目跟着筛；筛空了的项目整行不出 ----
  // 没有项目的那一组的键是空的
  must(
    JSON.stringify(seen.groupsBefore.local) ===
      JSON.stringify([':pinned', ':section:sec-later', 'litch', 'docs', '']) &&
      seen.groupsBefore.build?.join() === 'litch2,infra' &&
      seen.groupsBefore.nas?.join() === 'bk',
    `没筛的时候各组不对：${JSON.stringify(seen.groupsBefore)}`,
  )
  must(
    seen.groupsAfter.local?.join() === ':pinned,litch,docs',
    `只看 Pi 的时候本机下面的组不对（分区、无项目里没有 Pi 的，不该出）：${seen.groupsAfter.local?.join()}`,
  )
  must(
    seen.groupsAfter.build?.join() === 'litch2',
    `只看 Pi 的时候 build-01 上没有 Pi 会话的项目（infra）还在：${seen.groupsAfter.build?.join()}`,
  )
  must(
    seen.groupsAfter.nas?.length === 0 && seen.none.nas?.join() === '没有符合筛选的会话',
    `只看 Pi 的时候 nas 下面该只剩一句“没有符合筛选的会话”：${seen.groupsAfter.nas?.join()}｜${seen.none.nas?.join()}`,
  )
  must(
    ['local', 'build', 'gpu'].every((deviceId) => seen.none[deviceId]?.length === 0),
    `还有会话的设备下面不该写“没有符合筛选的会话”：${JSON.stringify(seen.none)}`,
  )
  must(!seen.moreAfter, '只看 Pi 的时候 docs-site 只剩三个会话，不该还有“展示更多”')

  must(seen.pickedGone, '到别处去之后，原来开着的那个 Claude Code 的会话还留在筛过的树里')
  must(
    seen.tally === '待审批｜｜未读｜1/0/0/1',
    `筛着的时候收起的项目上的汇总不对（别的 harness 在跑的不算，等审批的照算）：${seen.tally}`,
  )
  for (const entry of seen.skins) {
    const [where, text, button, over, height] = entry.split('｜')
    must(Number(text) >= 4.5, `${where} 下“正在只看”那一行的字看不清（对比度 ${text}）`)
    must(Number(button) >= 3, `${where} 下开着的筛选入口和底色分不开（对比度 ${button}）`)
    must(over === '0', `${where} 下侧栏顶上那一块横向溢出了 ${over} 像素`)
    must(
      Number(height) >= 20 && Number(height) <= 28,
      `${where} 下“正在只看”那一行高度不对：${height}`,
    )
  }
  must(seen.skins.length === 6, `皮肤没有量全：${seen.skins.length}`)

  // ---- 再挑上 Codex ----
  must(
    seen.twoLine === 'PI CX｜只看 Pi、Codex',
    `挑了两个之后“正在只看”那一行写的不对：${seen.twoLine}`,
  )
  must(seen.twoSaved === 'pi,codex', `挑了两个之后记在界面本地的不对：${seen.twoSaved}`)
  const twoRows = seen.twoRows.map(parse)
  must(
    twoRows.some((row) => row.badge === 'CX') &&
      twoRows.some((row) => row.badge === 'PI') &&
      twoRows.every((row) => row.badge === 'PI' || row.badge === 'CX' || row.waiting),
    `挑了 Pi 和 Codex 之后本机下面的会话不对：${seen.twoRows.join('、')}`,
  )

  // ---- 取消 ----
  must(
    seen.cleared && seen.savedAfter === null,
    `点“正在只看”那一行没有取消筛选：${seen.savedAfter}`,
  )
  must(
    JSON.stringify(seen.restored) === JSON.stringify(seen.before),
    `取消筛选之后树里和筛之前不一样：${JSON.stringify(seen.restored)}`,
  )

  // ---- 应用重开之后还记得 ----
  must(kept.line === 'pi｜只看 Pi', `应用重开之后不记得上次只看的是谁：${kept.line}`)
  const keptRows = kept.rows.map(parse)
  must(
    keptRows.length >= 4 &&
      keptRows.every((row) => row.badge === 'PI' || row.waiting) &&
      keptRows.some((row) => row.title === CLAUDE_WAITING),
    `应用重开之后树没有照上次的筛选来：${kept.rows.join('、')}`,
  )
  return failed
}
