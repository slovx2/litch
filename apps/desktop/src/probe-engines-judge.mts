// 三个引擎各走一遍的验收：把每一步各家看到的交给那一步的判定，合成结果和一张表。
// 判定分三种：
//   fail    不该出现的：验收不过
//   known   适配器那一头已经知道的毛病，这一遍还是老样子：验收照过，结果里列出来。改好了不算错，
//           老样子和改好了这两种表现之外的才是 fail。每一处旁边都写着它是什么、该是什么
//   note    不是毛病、但要让看结果的人知道的：这一家声明了不会、夹具里量不到
import { TALK } from './probe-engines-judge-talk.mjs'
import { WORK } from './probe-engines-judge-work.mjs'
import { type EnginesSeen, SPECS, type StepJudge } from './probe-engines-spec.mjs'

export interface Judged {
  failed: string[]
  /** 适配器那一头已知的毛病里这一遍还是老样子的，和要让看结果的人知道的那几句 */
  known: string[]
  /** 步骤 → 哪一家 → 一个词：过、过（有已知缺陷）、没过、没走下来，或者那一步自己写的（没有、量不到） */
  table: Record<string, Record<string, string>>
}

const JUDGES: Record<string, StepJudge> = { ...TALK, ...WORK }

export function judgeEngines(seen: EnginesSeen): Judged {
  const failed: string[] = []
  const known: string[] = []
  const table: Judged['table'] = {}
  const check = (ok: unknown, what: string) => {
    if (!ok) failed.push(what)
  }
  check(seen.device?.workspace, '设备：给三家共用的工作目录建的项目没有出现在侧栏里')
  table.device = {}
  for (const id of seen.ids) {
    const spec = SPECS[id]
    const shown = seen.device?.harnesses.find((entry) => entry.id === id)
    const before = failed.length
    check(
      shown?.state === 'ready',
      `设备／${id}：不是“可用”（${shown?.state ?? '没列出来'}：${shown?.said ?? ''}）`,
    )
    check(shown?.name === spec?.name, `设备／${id}：名字是“${shown?.name}”，该是“${spec?.name}”`)
    check(
      shown?.badge === spec?.badge,
      `设备／${id}：徽标是“${shown?.badge}”，该是“${spec?.badge}”`,
    )
    check(
      /^\d+\.\d+\.\d+/.test(shown?.version ?? ''),
      `设备／${id}：没有版本号（${shown?.version}）`,
    )
    table.device[id] = failed.length === before ? `过（${shown?.version}）` : '没过'
  }
  for (const [name, row] of Object.entries(seen.steps)) {
    const cells: Record<string, string> = {}
    table[name] = cells
    for (const [id, result] of Object.entries(row)) {
      const spec = SPECS[id]
      const judge = JUDGES[name]
      const error = (result as { error?: string } | null)?.error
      // 哪一家哪一步没走下来，都是不过
      if (error || !spec || !judge) {
        failed.push(`${name}／${id}：没走下来：${error ?? '没有这一步的判定'}`)
        cells[id] = '没走下来'
        continue
      }
      const counts = { fail: 0, known: 0 }
      let cell = ''
      judge(
        id,
        spec,
        result,
        {
          fail(what) {
            counts.fail++
            failed.push(`${name}／${id}：${what}`)
          },
          known(what) {
            counts.known++
            known.push(`${name}／${id}：已知缺陷：${what}`)
          },
          note(what) {
            known.push(`${name}／${id}：${what}`)
          },
          check(ok, what) {
            if (ok) return
            counts.fail++
            failed.push(`${name}／${id}：${what}`)
          },
          cell(text) {
            cell = text
          },
        },
        seen.place,
      )
      cells[id] = counts.fail > 0 ? '没过' : cell || (counts.known > 0 ? '过（有已知缺陷）' : '过')
    }
  }
  return { failed, known, table }
}
