// R2 的回合形状：后台续跑、过程、用户补充、过程、长回答、唯一的完成行。
import type { ItemView, SessionView } from '@litch/core'
import { ALL_ABLE } from '../../../../packages/core/src/projection/session.mts'
import { NO_SETTINGS } from '../../../../packages/core/src/projection/settings.mts'

export function midTurnFixture(): SessionView {
  const items: ItemView[] = []
  const note = (id: string, text: string) =>
    items.push({ id, kind: 'agentMessage', text, phase: 'commentary', status: 'completed' })
  const steps = (prefix: string, count: number) => {
    for (let i = 0; i < count; i++)
      items.push({
        id: `${prefix}-${i}`,
        kind: 'command',
        command: '检查运行记录',
        cwd: '/work',
        output: '',
        elided: null,
        exitCode: 0,
        durationMs: 1000,
        startedAt: null,
        status: 'completed',
      })
  }
  for (let i = 0; i < 3; i++) note(`before-${i}`, '正在核对后台任务和角色状态。')
  steps('before-step', 6)
  items.push({
    id: 'addition',
    kind: 'userMessage',
    text: '为什么又倒了，人物有防御吗？',
    attachments: [],
  })
  for (let i = 0; i < 5; i++) note(`after-${i}`, '继续检查防御加成、战斗日志与行动顺序。')
  steps('after-step', 10)
  items.push({
    id: 'answer',
    kind: 'agentMessage',
    phase: 'final',
    status: 'completed',
    text: '有防御，人物前 4 回合的防御效果仍然存在。\n\n我核对了战斗日志、状态变化和后台任务记录。倒下发生在防御效果结束之后，连续受到的伤害超过了剩余生命值。\n\n### 已确认的情况\n\n- 防御技能正常触发，前几轮减伤有效。\n- 后续回合没有及时补上防御，治疗也晚于敌方攻击。\n- 这次检查仍属于后台任务结束后开始的同一个回合。\n\n接下来会调整防御和恢复的顺序，让角色在承受连续攻击前保留足够的生命值。',
  })
  return {
    deviceId: 'local',
    sessionId: 's3',
    title: '回合中途补充',
    harness: 'claude',
    cwd: '/work',
    live: true,
    note: null,
    queued: [],
    settings: NO_SETTINGS,
    usage: null,
    forkedFrom: null,
    can: { ...ALL_ABLE, finalOnStart: false },
    agents: [],
    proposals: [],
    requests: [],
    turns: [
      {
        id: 'mid-turn',
        origin: 'backgroundTask',
        status: 'completed',
        itemIds: items.map((i) => i.id),
        startedAt: new Date('2026-10-30T14:47:38+08:00').getTime(),
        durationMs: 196000,
        error: null,
      },
    ],
    items: Object.fromEntries(items.map((i) => [i.id, i])),
  }
}
