import {
  EXTERNAL_IDENTITY_VERIFICATION_URL,
  type ExternalIdentity,
  type ExternalIdentityAuthorization,
  type ExternalIdentityLogin,
} from '../../../protocol/src/external-sources.mjs'
import { ChannelError, type Clock } from '../channel/protocol.mjs'

interface LoginHost {
  clock: Clock
  profile(owner: boolean, scopes: string[]): ExternalIdentityAuthorization
  commit(result: ExternalIdentityAuthorization, kind: 'oauth' | 'fine_grained'): ExternalIdentity
  changed(loginId: string, revision: number): void
}

export function mockIdentityLogin({ clock, profile, commit, changed }: LoginHost) {
  const records = new Map<string, ExternalIdentityLogin>()
  const kinds = new Map<string, 'oauth' | 'fine_grained'>()
  let seq = 0
  const issue = () => ({
    loginId: `login-${++seq}`,
    revision: 1,
    expiresAt: Math.floor(clock.now() / 1000) + 600,
  })
  const save = (record: ExternalIdentityLogin) => {
    records.set(record.loginId, record)
    changed(record.loginId, record.revision)
    return record
  }
  function succeed(
    prior: { loginId: string; revision: number; expiresAt: number },
    owner: boolean,
    scopes: string[],
  ) {
    const result = profile(owner, scopes)
    const identity = owner ? undefined : commit(result, kinds.get(prior.loginId) ?? 'oauth')
    return save({
      ...prior,
      revision: prior.revision + 1,
      state: 'succeeded',
      needsConfirmation: owner,
      result: identity ? { ...result, identity } : result,
    })
  }
  function get(id: string) {
    const state = records.get(id)
    if (!state) throw new ChannelError('notFound', 'Authorization not found')
    if (
      state.expiresAt <= Math.floor(clock.now() / 1000) &&
      (state.state === 'waiting' || (state.state === 'succeeded' && state.needsConfirmation))
    ) {
      return save({
        loginId: id,
        revision: state.revision + 1,
        expiresAt: state.expiresAt,
        state: 'expired',
      })
    }
    return state
  }
  return {
    add(scopes: string[]) {
      const start = issue()
      kinds.set(start.loginId, 'oauth')
      const waiting = save({
        ...start,
        state: 'waiting',
        verificationUrl: EXTERNAL_IDENTITY_VERIFICATION_URL,
        userCode: 'F1X2-C0DE',
      })
      clock.setTimer(() => {
        if (get(start.loginId).state === 'waiting') succeed(start, false, scopes)
      }, 450)
      return waiting
    },
    import() {
      const start = issue()
      kinds.set(start.loginId, 'oauth')
      return succeed(start, true, ['repo', 'read:org', 'gist'])
    },
    paste() {
      const start = issue()
      kinds.set(start.loginId, 'fine_grained')
      return succeed(start, false, [])
    },
    get,
    cancel(loginId: string) {
      const before = get(loginId)
      if (before.state !== 'waiting' && !(before.state === 'succeeded' && before.needsConfirmation))
        return before
      return save({
        loginId,
        expiresAt: before.expiresAt,
        revision: before.revision + 1,
        state: 'canceled',
      })
    },
    confirm(loginId: string, revision: number) {
      const before = get(loginId)
      if (before.state !== 'succeeded' || !before.needsConfirmation || before.revision !== revision)
        throw new ChannelError('conflict', 'Authorization changed')
      const identity = commit(before.result, kinds.get(loginId) ?? 'oauth')
      return save({
        ...before,
        revision: revision + 1,
        needsConfirmation: false,
        result: { ...before.result, identity },
      })
    },
  }
}
