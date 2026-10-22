// 模拟核心里的账号额度（accountLimits 主题）：Claude Code 和 Codex 各给一份订阅额度，别的 harness 没有。
// 只给快照，不变化
import type { AccountLimitRow, AccountLimitsView } from '../model-limits.mjs'

const MINUTE = 60_000

const SAMPLES: Record<string, (now: number) => AccountLimitRow[]> = {
  claude: (now) => [
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
