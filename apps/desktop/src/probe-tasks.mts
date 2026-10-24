// 定时任务的验收，对着模拟核心：侧栏入口带着没看过的数；列表按设备分开（不支持的那台说一句）；
// 在表单里新建一个任务、表单底下说得出下一次；建好进详情、回列表看得到它；立即运行一次跑完、
// 运行记录里点“去会话”打开那个会话，会话顶上那一条说是哪个任务的哪一次，点“去看任务”回到这个任务。
// 回合停在审批上的（本机的构建监控）：列表那一行和运行记录标“等你处理”、说还剩几分钟；到时限自动拒绝了的
// （build-01 的夜间测试）运行记录里说等了多久、已自动拒绝。
// 模拟核心的示例任务见 packages/core/src/mock/sample-tasks.mts：本机和 build-01 有任务，nas 的服务不支持，
// gpu-box 没连上。立即运行在模拟核心里真的演一次：排队、开出一个会话、发提示词、回答完了算成功。
// 和别的验收一样，tasksProbe 会被原样送进页面里执行，不能引用函数外面的东西；judgeTasks 在主进程里跑。

export interface TasksProbe {
  /** 侧栏底下“定时任务”后面的数（没看过的运行合计） */
  badge: number
  /** 列表：每一节是哪台设备、几行；nas 那一节说的话 */
  sections: string[]
  rows: number
  unsupported: string
  /** 等人处理：列表那一行的记号、详情里运行那一行的记号、那条审批说的话；自动拒绝了的那条说的话 */
  askingRow: boolean
  askingRun: boolean
  askWaiting: string
  askDeclined: string
  /** 表单：打开了没有、底下那一句是哪一种（at：算出了下一次）、说的什么 */
  formShown: boolean
  preview: string
  previewText: string
  /** 建好之后：详情页的标题、日程那一行；回到列表里有没有这一行 */
  created: string
  schedule: string
  /** 表单上出了“每次在新工作树里跑”、勾上了 */
  worktreeOffered: boolean
  /** 详情里“运行方式”那一行 */
  target: string
  listed: boolean
  /** 立即运行：说了什么、跑完的那一次是什么状态 */
  said: string
  runStatus: string
  /** 点“去会话”之后：标题栏、选中的那一行、会话顶上那一条（哪一种、说的什么） */
  crumb: string
  selected: string
  note: string
  noteText: string
  /** 点“去看任务”回到的详情页的标题 */
  backTo: string
}

export const TASK_NAME = '验收建的周报'

export async function tasksProbe(name: string): Promise<TasksProbe> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 30_000,
  ): Promise<T> => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    const last = check()
    if (last) return last
    throw new Error(`定时任务的验收：等不到${what}（页面上是 ${text(one('.main')).slice(0, 200)}）`)
  }
  /** 往受控的输入框里填字：经原生的写值口子写，再发一个 input，React 才认 */
  const fill = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const click = (selector: string) =>
    until<HTMLButtonElement>(`可以点的 ${selector}`, () => {
      const target = one<HTMLButtonElement>(selector)
      return target && !target.disabled ? target : null
    }).then((target) => target.click())

  // 侧栏入口：数要等示例任务到了才有
  const link = await until('侧栏底下的“定时任务”', () => one<HTMLElement>('.sb-btn.tasks'))
  const badge = Number(text(await until('入口上没看过的数', () => one('.sb-btn.tasks .sb-count'))))

  // 列表
  link.click()
  await until('定时任务列表', () => one('[data-tasks="list"]') && all('.tk-row').length >= 7)
  const sections = all('.tk-dev').map(
    (section) => `${section.dataset.device}:${all('.tk-row', section).length}`,
  )
  const rows = all('.tk-row').length
  const unsupported = text(one('.tk-dev[data-device="nas"] .arch-note'))

  // 等人处理的和自动拒绝了的
  const openTask = async (id: string) => {
    one<HTMLButtonElement>(`.tk-row[data-task="${id}"] .tk-row-btn`)?.click()
    await until(`${id} 的运行记录`, () => one(`[data-tasks="detail"] .tk-run`))
  }
  const backToList = async () => {
    await click('[data-tasks="detail"] [data-act="back"]')
    await until('回到列表', () => one('[data-tasks="list"]') && one('.tk-row'))
  }
  const askingRow = Boolean(one('.tk-row[data-task="task-watch"] [data-mark="asking"]'))
  await openTask('task-watch')
  const askingRun = Boolean(one('.tk-run[data-status="running"] [data-mark="asking"]'))
  const askWaiting = text(
    await until('等着的那条审批', () => one('.tk-run-asks li[data-state="waiting"]')),
  )
  await backToList()
  await openTask('task-nightly')
  const askDeclined = text(
    await until('自动拒绝了的那条', () => one('.tk-run-asks li[data-state="autoDeclined"]')),
  )
  await backToList()

  // 新建：名字、提示词、每周一和周五、工作目录
  await click('[data-act="new-task"]')
  const form = await until('新建表单', () => one('.tk-form'))
  fill(await until('名字', () => one<HTMLInputElement>('#tk-name')), name)
  fill(
    await until('提示词', () => one<HTMLTextAreaElement>('#tk-prompt')),
    '把这周的提交整理成周报',
  )
  one<HTMLButtonElement>('[data-kind="repeat"] .pick-btn')?.click()
  const weekly = await until('“每周”那一项', () =>
    all('.pick-pop [role="option"]').find((option) => text(option).startsWith('每周')),
  )
  weekly.click()
  await until('星期几那一排', () => one('[data-day="FR"]'))
  one<HTMLButtonElement>('[data-day="FR"]')?.click()
  fill(await until('工作目录', () => one<HTMLInputElement>('#tk-cwd')), '~/work/litch')
  // 目录在仓库里：出“每次在新工作树里跑”，勾上
  const worktreeBox = await until('“每次在新工作树里跑”', () =>
    one<HTMLInputElement>('[data-act="task-worktree"]'),
  )
  worktreeBox.click()
  const worktreeOffered = worktreeBox.checked
  await sleep(50)
  const previewBox = one('.tk-preview')
  const preview = previewBox?.dataset.preview ?? ''
  const previewText = text(previewBox)
  await click('[data-act="save-task"]')
  await until('建好之后的详情', () => text(one('[data-tasks="detail"] [data-task-name]')) === name)
  const created = text(one('[data-task-name]'))
  const schedule = text(one('.tk-facts dd'))
  const targetFact = all('.tk-facts > div').find((entry) => text(one('dt', entry)) === '运行方式')
  const target = text(one('dd', targetFact))

  // 回到列表看得到它，再点开
  await click('[data-tasks="detail"] [data-act="back"]')
  const row = await until('列表里刚建的那一行', () =>
    all('.tk-row').find((entry) => text(one('.tk-row-name', entry)) === name),
  )
  const listed = Boolean(row)
  one<HTMLButtonElement>('.tk-row-btn', row)?.click()
  await until('刚建的那个任务的详情', () => text(one('[data-task-name]')) === name)

  // 立即运行：等它跑完，运行记录里出现“去会话”
  await click('[data-act="run-now"]')
  const said =
    (await until('立即运行之后那一句', () => one<HTMLElement>('[data-said]')))?.dataset.said ?? ''
  const done = await until(
    '跑完的那一次',
    () =>
      all('.tk-run').find(
        (entry) => entry.dataset.status === 'succeeded' && one('[data-act="open-run"]', entry),
      ),
    60_000,
  )
  const runStatus = done.dataset.status ?? ''

  // 去会话：会话顶上那一条
  one<HTMLButtonElement>('[data-act="open-run"]', done)?.click()
  const note = await until('会话顶上那一条', () => one<HTMLElement>('.task-note'))
  await until('会话的内容', () => one('.tr .turn'))
  const crumb = text(one('.tb'))
  const selected = text(one('.ss-row.sel .title'))
  const noteKind = note.dataset.taskNote ?? ''
  const noteText = text(note)

  // 去看任务：回到这个任务的详情
  one<HTMLButtonElement>('[data-act="open-task"]', note)?.click()
  await until('回到任务的详情', () => one('[data-tasks="detail"] [data-task-name]'))
  const backTo = text(one('[data-task-name]'))
  one<HTMLButtonElement>('[data-tasks="detail"] .arch-head .ibtn:last-child')?.click()
  await until('关掉定时任务那一页', () => !one('[data-tasks]'))
  void form

  return {
    badge,
    sections,
    rows,
    unsupported,
    askingRow,
    askingRun,
    askWaiting,
    askDeclined,
    formShown: true,
    preview,
    previewText,
    created,
    schedule,
    worktreeOffered,
    target,
    listed,
    said,
    runStatus,
    crumb,
    selected,
    note: noteKind,
    noteText,
    backTo,
  }
}

export function judgeTasks(seen: TasksProbe, name: string): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(seen.badge > 0, `侧栏入口上没看过的数是 ${seen.badge}`)
  must(
    seen.sections.some((entry) => entry.startsWith('local:')) &&
      seen.sections.some((entry) => entry.startsWith('build:')),
    `列表没按设备分开：${seen.sections.join('、')}`,
  )
  must(seen.rows >= 7, `列表只有 ${seen.rows} 行`)
  must(seen.unsupported.includes('不支持'), `不支持的那台没说清楚：“${seen.unsupported}”`)
  must(seen.askingRow, '回合停在审批上的任务，列表那一行没标“等你处理”')
  must(seen.askingRun, '回合停在审批上的那次运行没标“等你处理”')
  must(
    /^命令：npm run build -- --clean等你处理，打开会话即可回应；\d+ 分钟后自动拒绝$/.test(
      seen.askWaiting,
    ),
    `等着的那条审批说的是“${seen.askWaiting}”`,
  )
  must(
    /^改文件：更新快照文件等了 30 分钟没人处理，.+ 已自动拒绝$/.test(seen.askDeclined),
    `自动拒绝了的那条说的是“${seen.askDeclined}”`,
  )
  must(seen.formShown, '新建表单没出来')
  must(
    seen.preview === 'at' && seen.previewText.startsWith('下次运行：'),
    `表单底下没说出下一次：${seen.preview}“${seen.previewText}”`,
  )
  must(seen.created === name, `建好之后的详情不是这个任务：“${seen.created}”`)
  must(seen.schedule.includes('每周一、五'), `详情里的日程不对：“${seen.schedule}”`)
  must(seen.worktreeOffered, '目录在仓库里，表单上没出“每次在新工作树里跑”或勾不上')
  must(seen.target === '每次新建会话，在新工作树里跑', `详情里的运行方式是“${seen.target}”`)
  must(seen.listed, '回到列表里没有刚建的那一行')
  must(seen.said === 'started', `立即运行之后说的是 ${seen.said}`)
  must(seen.runStatus === 'succeeded', `立即运行的那一次是 ${seen.runStatus}`)
  must(seen.selected.startsWith(name), `去会话之后选中的是“${seen.selected}”`)
  must(seen.crumb.includes(name), `标题栏上是“${seen.crumb}”`)
  must(
    seen.note === 'run' && seen.noteText.includes(name) && seen.noteText.includes('手动'),
    `会话顶上那一条不对：${seen.note}“${seen.noteText}”`,
  )
  must(seen.backTo === name, `点“去看任务”回到的是“${seen.backTo}”`)
  return failed
}
