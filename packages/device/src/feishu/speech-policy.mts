// 通用发言权限：按“来源 + 范围”记发言模式，数据模型不绑飞书。
// 飞书的范围是 `appId/chatId`；没有行就是没接入，一律不许发。模式只由用户在设置里改，经理改不了。
import type { ManagerStore } from '../manager-store.mjs'

export type SpeechMode = 'free' | 'approval'
export type SpeechDecision = SpeechMode | 'denied'

export interface SpeechPolicy {
  mode: SpeechMode
  updatedAt: number
}

export const SPEECH_POLICIES_MIGRATION = `
CREATE TABLE speech_policies(
  provider TEXT NOT NULL, scope TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(provider, scope)
);
`

export class SpeechPolicies {
  private readonly managers: ManagerStore
  constructor(managers: ManagerStore) {
    this.managers = managers
  }

  get(provider: string, scope: string): SpeechPolicy | null {
    const row = this.managers.db
      .prepare('SELECT body FROM speech_policies WHERE provider=? AND scope=?')
      .get(provider, scope)
    return row ? (JSON.parse(String(row.body)) as SpeechPolicy) : null
  }

  set(provider: string, scope: string, policy: SpeechPolicy): void {
    this.managers.db
      .prepare(
        `INSERT INTO speech_policies VALUES(?,?,?)
         ON CONFLICT(provider, scope) DO UPDATE SET body=excluded.body`,
      )
      .run(provider, scope, JSON.stringify(policy))
  }

  remove(provider: string, scope: string): void {
    this.managers.db
      .prepare('DELETE FROM speech_policies WHERE provider=? AND scope=?')
      .run(provider, scope)
  }

  /** 删掉一个来源下某个前缀的全部范围（比如移除飞书应用时的 `appId/`） */
  removePrefix(provider: string, prefix: string): void {
    this.managers.db
      .prepare('DELETE FROM speech_policies WHERE provider=? AND substr(scope, 1, ?)=?')
      .run(provider, prefix.length, prefix)
  }

  decide(provider: string, scope: string): SpeechDecision {
    return this.get(provider, scope)?.mode ?? 'denied'
  }
}
