import type { SessionScope, TurnScope } from './runtime.mjs'

export type SiteVerdict = 'allow' | 'decline' | 'blocked' | 'unknown'

/** 每个浏览器后端一份策略；不得把一个来源的批准复制到另一个宿主/后端。 */
export interface SitePolicy {
  verdict(scope: TurnScope, origin: string): SiteVerdict
  allowTurn(scope: TurnScope, origin: string): void
  allowSession(scope: SessionScope, origin: string): void
  allowAlways(origin: string): Promise<void>
  decline(scope: TurnScope, origin: string): void
  endTurn(scope: TurnScope): void
  endSession(scope: SessionScope): void
  saved(): Promise<readonly { origin: string; at: number }[]>
  forget(origin: string | null): Promise<void>
  settings(): { trustAll: boolean; blocked: readonly string[] }
  configure(settings: { trustAll: boolean; blocked: readonly string[] }): Promise<void>
}
