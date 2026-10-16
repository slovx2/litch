// 保存条：有没保存的改动时贴在详情页底下。整台设备的改动一起保存，一次写入要么全成、要么一项都不落。
// 为什么不是改一项存一项：有的改动要几项一起才成立（两个入口互换端口）；不少设置一改就要重启 harness，
// 逐项即存会一下一下地重启；停用 harness、关入口这类有后果的事，也该是用户明确按一下才发生。
import {
  type CoreChannel,
  type DeviceView,
  keys,
  type ManageRevisions,
  type ManageSchema,
  type Replica,
  type SettingsSnapshotView,
} from '@litch/core'
import { useT } from '../../app/appearance.ts'
import { whyNot } from '../../app/errors.ts'
import { useServices } from '../../app/services.tsx'
import { dismissToast, showToast } from '../../app/toasts.tsx'
import type { Translator } from '../../i18n/index.ts'
import {
  draftsOf,
  dropDrafts,
  editsOf,
  restoreDrafts,
  setFailure,
  setSaving,
  useDrafts,
} from './drafts.ts'

/** 保存成功之后，新的值最多等这么久（毫秒）还没到界面，就不等了 */
const SETTLE_MS = 1500

/**
 * 等这次写入的结果落进状态库。命令的应答比增量先到（增量是按帧合并着发的）：
 * 应答一到就收草稿的话，控件会先闪回旧值，过一帧才变成新的
 */
function settled(replica: Replica, deviceId: string, version: number): Promise<void> {
  const key = keys.manageSnapshot(deviceId)
  const arrived = () => replica.store.get<SettingsSnapshotView>(key)?.version !== version
  return new Promise((done) => {
    if (arrived()) return done()
    const stop = replica.store.subscribe(key, () => arrived() && finish())
    const timer = window.setTimeout(finish, SETTLE_MS)
    function finish() {
      stop()
      window.clearTimeout(timer)
      done()
    }
  })
}

const toastId = (deviceId: string) => `manage-save:${deviceId}`

/** 几个 harness 的名字连成一串，按当前语言的顿号 */
export function harnessNames(device: DeviceView, ids: readonly string[], t: Translator): string {
  return ids
    .map((id) => device.harnesses.find((entry) => entry.id === id)?.name ?? id)
    .join(t('list.comma'))
}

/** 把这台设备的草稿一次写进去 */
export async function saveDrafts(
  channel: CoreChannel,
  replica: Replica,
  device: DeviceView,
  schema: ManageSchema,
): Promise<void> {
  const deviceId = device.id
  const snapshot = replica.store.get<SettingsSnapshotView>(keys.manageSnapshot(deviceId))
  const edits = editsOf(schema.settings, draftsOf(deviceId).drafts)
  if (!snapshot || !edits || edits.length === 0 || draftsOf(deviceId).saving) return
  setFailure(deviceId, null)
  setSaving(deviceId, true)
  try {
    const result = await channel.command('device.settings.write', {
      deviceId,
      expectedVersion: snapshot.version,
      edits,
    })
    if (result.changed.length > 0) await settled(replica, deviceId, snapshot.version)
    dropDrafts(
      deviceId,
      edits.map((edit) => edit.key),
    )
    // 这次保存碰到的 harness 里还等着重启的：它们有回合在跑，没有去打断
    const touched = new Set(
      schema.settings.flatMap((spec) =>
        result.changed.includes(spec.key) && spec.scope.kind === 'harness'
          ? [spec.scope.harness]
          : [],
      ),
    )
    const waiting = result.pendingRestart.filter((id) => touched.has(id))
    showToast({
      id: toastId(deviceId),
      text: (t) =>
        waiting.length > 0
          ? t('manage.saved.pending', { names: harnessNames(device, waiting, t) })
          : result.restarted.length > 0
            ? t('manage.saved.restarted', { names: harnessNames(device, result.restarted, t) })
            : t('manage.saved'),
      lifeMs: waiting.length > 0 ? 9000 : 4000,
    })
  } catch (error) {
    const { code, key } = (error ?? {}) as { code?: string; key?: string }
    const conflict = code === 'conflict'
    setFailure(deviceId, { error, key: key ?? null, conflict })
    showToast({
      id: toastId(deviceId),
      tone: 'err',
      text: (t) =>
        conflict
          ? t('manage.save.conflict')
          : t('manage.save.failed', { reason: whyNot(error, t) }),
      lifeMs: 9000,
    })
  } finally {
    setSaving(deviceId, false)
  }
}

interface SaveBarProps {
  device: DeviceView
  schema: ManageSchema
  revisions: ManageRevisions
}

export function SaveBar({ device, schema, revisions }: SaveBarProps) {
  const { channel, replica } = useServices()
  const t = useT()
  const deviceId = device.id
  const { drafts, saving, failure } = useDrafts(deviceId)
  // 只算设备服务现在还声明着的那些项
  const dirty = schema.settings.filter((spec) => drafts[spec.key])
  if (dirty.length === 0) return null

  const conflicts = saving
    ? 0
    : dirty.filter((spec) => drafts[spec.key]?.base !== (revisions[spec.key] ?? 0)).length
  const wrong = editsOf(schema.settings, drafts) === null
  // 这些改动里有要重启才生效的：是哪几个 harness
  const restarts = [
    ...new Set(
      dirty.flatMap((spec) =>
        spec.restart === 'harness' && spec.scope.kind === 'harness' ? [spec.scope.harness] : [],
      ),
    ),
  ]

  const discard = () => {
    const gone = drafts
    const count = dirty.length
    dropDrafts(deviceId)
    showToast({
      id: toastId(deviceId),
      text: (say) => say('manage.discarded', { count }),
      action: {
        label: (say) => say('manage.discarded.undo'),
        run: () => {
          restoreDrafts(deviceId, gone)
          dismissToast(toastId(deviceId))
        },
      },
      lifeMs: 7000,
    })
  }

  let note: string | null = null
  let tone = ''
  if (conflicts > 0) {
    note = t('manage.save.resolve', { count: conflicts })
    tone = ' err'
  } else if (wrong) {
    note = t('manage.save.fix')
    tone = ' err'
  } else if (failure?.conflict) {
    note = t('manage.save.conflict')
    tone = ' err'
  } else if (failure && failure.key === null) {
    note = t('manage.save.failed', { reason: whyNot(failure.error, t) })
    tone = ' err'
  } else if (restarts.length > 0) {
    note = t('manage.save.restarts', { names: harnessNames(device, restarts, t) })
  }

  return (
    <footer className="mng-save" data-dirty-count={dirty.length} data-saving={saving}>
      <div className="mng-save-in">
        <div className="mng-save-text">
          <b>{t('manage.save.count', { count: dirty.length })}</b>
          {note ? (
            <span className={`mng-save-note${tone}`} role={tone ? 'alert' : undefined}>
              {note}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="btn ghost"
          data-act="discard"
          disabled={saving}
          onClick={discard}
        >
          {t('manage.discard')}
        </button>
        <button
          type="button"
          className="btn primary"
          data-act="save"
          disabled={saving || conflicts > 0 || wrong}
          onClick={() => void saveDrafts(channel, replica, device, schema)}
        >
          {t(saving ? 'manage.saving' : 'manage.save')}
        </button>
      </div>
    </footer>
  )
}
