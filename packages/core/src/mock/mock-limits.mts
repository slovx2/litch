// 模拟核心里的账号额度（accountLimits 主题）：Claude Code、Codex、Antigravity 的虚构订阅额度。
// 只给快照，不变化
import type { AccountLimitRow, AccountLimitsView } from '../model-limits.mjs'

const MINUTE = 60_000

const SAMPLES: Record<string, (now: number) => AccountLimitRow[]> = {
  agy: (now) => [
    {
      id: 'agy:gemini-5h:primary',
      name: 'Gemini Models',
      window: { usedPercent: 25, windowMins: 300, resetsAt: now + 133 * MINUTE },
    },
    {
      id: 'agy:gemini-weekly:primary',
      name: 'Gemini Models',
      window: { usedPercent: 64, windowMins: 10080, resetsAt: now + 4 * 1440 * MINUTE },
    },
    {
      id: 'agy:3p-5h:primary',
      name: 'Claude and GPT models',
      window: { usedPercent: 92, windowMins: 300, resetsAt: now + 41 * MINUTE },
    },
    {
      id: 'agy:3p-weekly:primary',
      name: 'Claude and GPT models',
      window: { usedPercent: 100, windowMins: 10080, resetsAt: now + 6 * 1440 * MINUTE },
    },
    {
      id: 'agy:argon-weekly:primary',
      name: 'Gemini 4 Argon',
      window: { usedPercent: 0, windowMins: 10080, resetsAt: now + 2 * 1440 * MINUTE },
    },
  ],
  'claude-code': (now) => [
    {
      id: 'claude-code:primary',
      name: null,
      window: { usedPercent: 37, windowMins: 300, resetsAt: now + 133 * MINUTE },
    },
    {
      id: 'claude-code:secondary',
      name: null,
      window: { usedPercent: 18, windowMins: 10080, resetsAt: now + 4 * 1440 * MINUTE },
    },
    {
      id: 'claude-code:seven_day_sonnet:primary',
      name: 'Sonnet',
      window: { usedPercent: 3, windowMins: 10080, resetsAt: now + 4 * 1440 * MINUTE },
    },
    {
      id: 'claude-code:model:Fable:primary',
      name: 'Fable',
      window: {
        usedPercent: 92,
        windowMins: 10080,
        resetsAt: now + 2 * 1440 * MINUTE + 300 * MINUTE,
      },
    },
  ],
  codex: (now) => [
    {
      id: 'codex:primary',
      name: null,
      window: { usedPercent: 12, windowMins: 300, resetsAt: now + 41 * MINUTE },
    },
    {
      id: 'codex:secondary',
      name: null,
      window: { usedPercent: 64, windowMins: 10080, resetsAt: now + 6 * 1440 * MINUTE },
    },
  ],
}

export function mockAccountLimits(
  deviceId: string,
  harness: string,
  now: number,
): AccountLimitsView {
  return { deviceId, harness, rows: SAMPLES[harness]?.(now) ?? [] }
}
