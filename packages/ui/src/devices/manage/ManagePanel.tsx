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
import { useKey, useServices } from '../../app/services.tsx'
import { useInstall } from '../../install/useInstall.ts'
import { Diagnostics, Logs } from './Diagnostics.tsx'
import { adoptDrafts, useDrafts } from './drafts.ts'
import { InheritedEnv } from './EnvEditor.tsx'
import { FoldSection } from './FoldSection.tsx'
import { HarnessBlock } from './HarnessBlock.tsx'
import { SaveBar } from './SaveBar.tsx'
import { LeadSwitch, SettingRow } from './SettingRow.tsx'
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

export function ManagePanel({ device }: { device: DeviceView }) {
  const { replica } = useServices()
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
  if (!schema || !snapshot) {
    return (
      <div className="mng-state" data-manage-state="loading">
        {t('manage.loading')}
      </div>
    )
  }

  const nameOfHarness = (id: string) =>
    device.harnesses.find((entry) => entry.id === id)?.name ?? id
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
      <section className="mng-sec" data-sec="harnesses">
        <div className="mng-sec-head">
          <h2>{t('manage.harness.title')}</h2>
        </div>
        {harnessIds.map((id) => {
          const specs = ofHarness(id)
          const buckets = bucketsOf(schema, specs)
          // 设备服务标成“启用开关”的那一项：标题行上也放一个，不用点开就能拨。
          // 认的是它带的角色标记，不认键名，也不看它排在第几；没有哪一项带着就没有这个开关
          const lead = specs.find((spec) => spec.role === 'enable' && spec.type === 'boolean')
          return (
            <HarnessBlock
              key={id}
              device={device}
              harnessId={id}
              harness={device.harnesses.find((entry) => entry.id === id)}
              install={install}
              pending={snapshot.pendingRestart.includes(id)}
              forced={touched(specs)}
              toggle={
                lead ? (
                  <LeadSwitch
                    deviceId={deviceId}
                    spec={lead}
                    snapshot={snapshot}
                    revision={revisions[lead.key] ?? 0}
                    draft={drafts[lead.key]}
                    saving={saving}
                  />
                ) : null
              }
            >
              {buckets.map((bucket) => (
                <div key={bucket.group?.id ?? ''} className="mng-bucket">
                  {/* 一个 harness 的设置通常就一组，组名就是它自己，不用再写一遍 */}
                  {buckets.length > 1 && bucket.group ? (
                    <h4>{t.said(bucket.group.title)}</h4>
                  ) : null}
                  {bucket.specs.map(row)}
                </div>
              ))}
              {buckets.length === 0 ? (
                <div className="form-note">{t('manage.harness.noSettings')}</div>
              ) : null}
            </HarnessBlock>
          )
        })}
        <InheritedEnv entries={schema.inheritedEnv} />
      </section>
      <SshEntries device={device} snapshot={snapshot} />
      {deviceBuckets.map((bucket) => {
        const on = switchesOn(bucket.specs, snapshot)
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
            <div className="mng-rows">{bucket.specs.map(row)}</div>
          </FoldSection>
        )
      })}
      <Diagnostics device={device} />
      <Logs device={device} />
      <SaveBar device={device} schema={schema} revisions={revisions} />
    </div>
  )
}
