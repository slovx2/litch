// 一台设备的管理：harness 一个一块，然后是 SSH 入口的状况、设备级的设置、诊断和日志。
// 设置有哪些、各是什么类型都是设备服务声明的，这里只管按分组和作用范围把它们摆开。
// 一打开只露一眼要看的：harness 各一行，设备级的每组设置收成一行标题加一句摘要，点开才是里面的设置项；
// 哪一块里有没保存的改动，那一块自己开着。
// 开着这一页才订阅管理数据；之后别处改了设置，页面跟着变——用户正在改还没保存的那几栏不动，另行提示。
import {
  type ChannelErrorShape,
  type DeviceView,
  keys,
  type ManageRevisions,
  type ManageSchema,
  type SettingGroupView,
  type SettingSpecView,
  type SettingsSnapshotView,
} from '@litch/core'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { whyNot } from '../../app/errors.ts'
import { leaveThen, useLeaveGuard } from '../../app/leave-guard.tsx'
import { useKey, useServices } from '../../app/services.tsx'
import { useInstall } from '../../install/useInstall.ts'
import { WorktreeList } from '../../worktrees/WorktreeList.tsx'
import { Diagnostics, Logs } from './Diagnostics.tsx'
import { adoptDrafts, draftsOf, dropDrafts, useDrafts } from './drafts.ts'
import { InheritedEnv } from './EnvEditor.tsx'
import { FoldSection } from './FoldSection.tsx'
import { HarnessBlock } from './HarnessBlock.tsx'
import { ModelRanking } from './ModelRanking.tsx'
import { PowerSettings } from './PowerSettings.tsx'
import { SaveBar, saveDrafts } from './SaveBar.tsx'
import { SettingRow } from './SettingRow.tsx'
import { SshEntries } from './SshEntries.tsx'

const NO_REVISIONS: ManageRevisions = {}

/** 一组设置：分组（没有声明分组的那些归在 null 下面）和里面的设置项 */
interface Bucket {
  group: SettingGroupView | null
  specs: SettingSpecView[]
}

/** 把几项设置按声明的分组分开，分组的顺序照声明的来 */
function bucketsOf(schema: ManageSchema, specs: readonly SettingSpecView[]): Bucket[] {
  const buckets: Bucket[] = schema.groups.map((group) => ({
    group,
    specs: specs.filter((spec) => spec.group === group.id),
  }))
  const known = new Set(schema.groups.map((group) => group.id))
  const loose = specs.filter((spec) => !known.has(spec.group))
  return [...buckets, { group: null, specs: loose }].filter((bucket) => bucket.specs.length > 0)
}

/** 一组设置里的开关现在开着几个。组里没有开关就是 null：这一组说不出“开着几个” */
function switchesOn(
  specs: readonly SettingSpecView[],
  snapshot: SettingsSnapshotView,
): number | null {
  const switches = specs.filter((spec) => spec.type === 'boolean')
  if (switches.length === 0) return null
  return switches.filter((spec) => snapshot.values[spec.key] === true).length
}

export function ManagePanel({
  device,
  onSettings,
  harnessId,
  revealRanking = false,
}: {
  device: DeviceView
  /** 打开一个 harness 的详情设置 */
  onSettings?(harnessId: string): void
  /** 详情页只显示这个 harness 的运行设置。 */
  harnessId?: string
  /** 别处要求直接看模型等级排序（越级提示里的跳转） */
  revealRanking?: boolean
}) {
  const { replica, channel } = useServices()
  const t = useT()
  const deviceId = device.id
  /** 订阅没成时点“重试”：换一个数，重新订阅 */
  const [attempt, setAttempt] = useState(0)
  /** 这一次订阅上之后，留下来的草稿对过了没有 */
  const adopted = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 变了就是要重新订阅
  useEffect(() => {
    adopted.current = false
    return replica.openManage(deviceId)
  }, [replica, deviceId, attempt])
  const schema = useKey<ManageSchema>(keys.manage(deviceId))
  const snapshot = useKey<SettingsSnapshotView>(keys.manageSnapshot(deviceId))
  const revisions = useKey<ManageRevisions>(keys.manageRevisions(deviceId)) ?? NO_REVISIONS
  const error = useKey<ChannelErrorShape>(keys.manageError(deviceId))
  const { drafts, saving, failure } = useDrafts(deviceId)
  const selected =
    schema?.settings.filter((spec) =>
      harnessId
        ? spec.scope.kind === 'harness' && spec.scope.harness === harnessId
        : spec.scope.kind === 'device',
    ) ?? []
  const scoped = schema ? { ...schema, settings: selected } : undefined
  const guard = useLeaveGuard(Boolean(harnessId && selected.some((spec) => drafts[spec.key])))
  guard.current = async () => {
    if (!scoped) return false
    await saveDrafts(channel, replica, device, scoped)
    return selected.every((spec) => !draftsOf(deviceId).drafts[spec.key])
  }
  const ownedKeys = useRef<string[]>([])
  ownedKeys.current = selected.map((spec) => spec.key)
  useEffect(
    () => () => {
      // 详情标签离开前已经处理保存/放弃；只清这一页的草稿，不影响设备页或其他 harness。
      if (harnessId) dropDrafts(deviceId, ownedKeys.current)
    },
    [deviceId, harnessId],
  )
  /** 设备能装 harness 时：各 harness 的版本和安装任务（每一块标题行下那一行） */
  const install = useInstall(device)

  // 这一页重新打开（或者重新订阅上）时，上次留下的草稿要对一遍：它们记的“被动过几次”是上一次订阅里的数。
  // 赶在画出来之前对完，免得那几栏先闪一下“被别处改过”
  useLayoutEffect(() => {
    if (!snapshot || adopted.current) return
    adopted.current = true
    adoptDrafts(deviceId, snapshot.values, revisions)
  }, [deviceId, snapshot, revisions])

  if (error) {
    return (
      <div className="mng-state err" data-manage-state="error" role="alert">
        <span>{t('manage.unreadable', { reason: whyNot(error, t) })}</span>
        <button type="button" className="btn" onClick={() => setAttempt((value) => value + 1)}>
          {t('sidebar.retry')}
        </button>
      </div>
    )
  }
  if (!schema || !snapshot || !scoped) {
    return (
      <div className="mng-state" data-manage-state="loading">
        {t('manage.loading')}
      </div>
    )
  }

  const nameOfHarness = (id: string) =>
    t.harness(id, device.harnesses.find((entry) => entry.id === id)?.name)
  const row = (spec: SettingSpecView) => (
    <SettingRow
      key={spec.key}
      deviceId={deviceId}
      spec={spec}
      snapshot={snapshot}
      revision={revisions[spec.key] ?? 0}
      draft={drafts[spec.key]}
      saving={saving}
      failure={failure}
      restarts={
        spec.restart === 'harness' && spec.scope.kind === 'harness'
          ? nameOfHarness(spec.scope.harness)
          : null
      }
    />
  )
  const ofHarness = (id: string) =>
    schema.settings.filter((spec) => spec.scope.kind === 'harness' && spec.scope.harness === id)
  if (harnessId)
    return (
      <div className="mng" data-manage-state="ready" data-runtime-settings={harnessId}>
        <HarnessBlock
          device={device}
          harnessId={harnessId}
          harness={device.harnesses.find((entry) => entry.id === harnessId)}
          install={install}
          pending={snapshot.pendingRestart.includes(harnessId)}
          detail
          settings={null}
        >
          {bucketsOf(schema, ofHarness(harnessId)).map((bucket) => (
            <div className="mng-bucket" key={bucket.group?.id ?? ''}>
              {bucket.specs.map(row)}
            </div>
          ))}
        </HarnessBlock>
        <SaveBar device={device} schema={scoped} revisions={revisions} />
      </div>
    )
  /** 这几项里有没保存的改动（填得不对的、被别处动过的也都在里面）：它们所在的那一块不能收着 */
  const touched = (specs: readonly SettingSpecView[]) => specs.some((spec) => spec.key in drafts)
  // 设备声明了的 harness 照它的顺序；设置里提到了、设备没声明的排在后面，不让它们的设置没处放
  const harnessIds = [
    ...new Set([
      ...device.harnesses.map((entry) => entry.id),
      ...schema.settings.flatMap((spec) =>
        spec.scope.kind === 'harness' ? [spec.scope.harness] : [],
      ),
    ]),
  ]
  const deviceBuckets = bucketsOf(
    schema,
    schema.settings.filter((spec) => spec.scope.kind === 'device'),
  )

  return (
    <div className="mng" data-manage-state="ready" data-version={snapshot.version}>
      {device.modelRanking && !harnessId && (
        <ModelRanking
          device={device}
          reveal={revealRanking}
          onSettings={onSettings ? (id) => leaveThen(() => onSettings(id)) : null}
        />
      )}
      <section className="mng-sec" data-sec="harnesses">
        <div className="mng-sec-head">
          <h2>{t('manage.harness.title')}</h2>
        </div>
        {harnessIds.map((id) => {
          return (
            <HarnessBlock
              key={id}
              device={device}
              harnessId={id}
              harness={device.harnesses.find((entry) => entry.id === id)}
              install={install}
              pending={snapshot.pendingRestart.includes(id)}
              settings={onSettings ? () => leaveThen(() => onSettings(id)) : null}
            >
              {null}
            </HarnessBlock>
          )
        })}
        <InheritedEnv entries={schema.inheritedEnv} />
      </section>
      <SshEntries device={device} snapshot={snapshot} />
      {deviceBuckets.map((bucket) => {
        // 工作树那一组的开关只有“先拉取”一项，“全部关闭”读起来像工作树关了：不出摘要
        const on = bucket.group?.id === 'worktrees' ? null : switchesOn(bucket.specs, snapshot)
        return (
          <FoldSection
            key={bucket.group?.id ?? ''}
            sec="group"
            group={bucket.group?.id ?? ''}
            title={bucket.group ? t.said(bucket.group.title) : t('manage.group.other')}
            forced={touched(bucket.specs)}
            summary={
              on === null ? null : (
                <span className="mng-sum" data-on={on}>
                  {on > 0 ? t('manage.group.on', { count: on }) : t('manage.group.allOff')}
                </span>
              )
            }
          >
            {bucket.group?.description ? (
              <p className="mng-sec-note">{t.said(bucket.group.description)}</p>
            ) : null}
            {bucket.group?.id === 'power' ? (
              <PowerSettings deviceId={deviceId} specs={bucket.specs} snapshot={snapshot} />
            ) : (
              <div className="mng-rows">{bucket.specs.map(row)}</div>
            )}
            {/* 工作树那一组下面列出这台设备上建过的工作树，能删、能恢复 */}
            {bucket.group?.id === 'worktrees' ? <WorktreeList device={device} /> : null}
          </FoldSection>
        )
      })}
      <Diagnostics device={device} />
      <Logs device={device} />
      <SaveBar device={device} schema={scoped} revisions={revisions} />
    </div>
  )
}
