// 预览用有限页数读取最近一天，运行与实际收件箱相同的规则，不落设备队列。
import type {
  ExternalDiagnostic,
  ExternalSourceDraft,
} from '../../../protocol/src/external-sources.mjs'
import { ExternalStore } from '../external-store.mjs'
import { ManagerStore, openPreviewManagerDatabase } from '../manager-store.mjs'
import type { DeviceExternalService } from './device-service.mjs'
import { ExternalDispatch } from './dispatch.mjs'
import { pollGithubRepository, SqliteGithubPollStore } from './github/poll.mjs'
import { ExternalIntakeService } from './intake.mjs'
import { createGithubExternalVerification } from './mandate-github.mjs'

export async function previewExternalSource(
  device: DeviceExternalService,
  draft: ExternalSourceDraft,
) {
  const [repo] = draft.repos
  const now = device.now()
  if (!repo) return { matches: [], diagnostics: [] }
  const manager = new ManagerStore(openPreviewManagerDatabase())
  try {
    for (const row of device.store.manager.managers()) manager.saveManager(row)
    const store = new ExternalStore(manager)
    const owner = device.store.config.owner('github')
    if (owner) store.config.setOwner(owner, 'preview', 0, 'preview')
    const credential = device.secrets.activeForRepository(
      repo.repoId,
      repo.pollIdentity ?? undefined,
    )
    store.config.saveCredential({ ...credential.metadata, generation: 1 }, 0, 'preview')
    const source = { ...draft, enabled: true }
    store.config.saveSource(source, 0, 'preview', 'preview')
    const api = device.poll.apiFor({ ...source, revision: 0, rulesVersion: 0, createdAt: now })
    const poll = new SqliteGithubPollStore(store, () => device.now() * 1000)
    const verification = createGithubExternalVerification(
      async () => api,
      (id) => store.config.source(id),
    )
    const existing = device.configuration.snapshot()
    const configuration = () => ({
      ...existing,
      repositories: [
        ...existing.repositories.filter((item) => item.repoId !== repo.repoId),
        { repoId: repo.repoId, labelRoutes: repo.labelRoutes ?? [] },
      ],
    })
    const dispatch = new ExternalDispatch(store, {
      configuration,
      now: device.now,
      canDeliver: () => false,
      send: async () => ({ outcome: 'not_sent' }),
    })
    const intake = new ExternalIntakeService(
      store,
      verification.lookupGithubRole,
      dispatch.queue,
      verification.recheckEvent,
      configuration,
    )
    const scan = await pollGithubRepository({
      sourceId: source.sourceId,
      repo,
      botUserId: credential.metadata.botUserId,
      api,
      store: poll,
      enabledAt: (now - 86_400) * 1000,
      pageBudget: 2,
      reviewBudget: 1,
    })
    const scope = { sourceId: source.sourceId, repoId: repo.repoId }
    const diagnostics: ExternalDiagnostic[] = []
    if (scan.fault)
      diagnostics.push({ check: 'repository', state: 'blocked', code: scan.fault.reason })
    else diagnostics.push({ check: 'repository', state: 'ok', code: 'github_repository_verified' })
    const limited =
      poll.evidence.pending(scope, 21).length > 20 ||
      scan.streams.some(({ cursor }) => !!cursor.scan)
    if (limited)
      diagnostics.push({ check: 'preview', state: 'unverified', code: 'github_preview_limited' })
    await intake.consumeGithub(poll.evidence, scope, now, verification, undefined, undefined, 20)
    return {
      matches: store
        .inbox({ sourceId: source.sourceId, limit: 20 })
        .entries.map(
          ({ seq: _seq, revision: _revision, delivery: _delivery, intakeId: _intakeId, ...row }) =>
            row,
        ),
      diagnostics,
    }
  } finally {
    manager.close()
  }
}
