import type { ComposeOptions, DeviceView } from '@litch/core'
import type { ManagerDraft } from '../../../core/src/model-manager.mts'
import { readRemembered, saveRemembered, writeRemembered } from '../app/remembered.ts'
import { defaultDevice, defaultHarness, fitPicks } from '../composer/new-place.ts'

export type ManagerFormDraft = Omit<ManagerDraft, 'template' | 'scope'>
type Defaults = Pick<
  ManagerFormDraft,
  'cwd' | 'harness' | 'model' | 'effort' | 'dispatch' | 'contact' | 'rules'
> & { workspaceId: string }

const defaultsKey = (deviceId: string) => `litch.manager.defaults:${deviceId}`
const DEVICE_KEY = 'litch.manager.lastDevice'

function stored(deviceId: string): Partial<Defaults> {
  return readRemembered<unknown>(defaultsKey(deviceId)) as Partial<Defaults>
}

/** 和普通新建对话一样，明确指定的设备优先，其次是本机记住的设备，再按现有设备回退。 */
export function managerDevice(devices: DeviceView[], explicit?: string): string {
  const last = readRemembered<unknown>(DEVICE_KEY).id
  if (explicit && devices.some((device) => device.id === explicit)) return explicit
  return (
    defaultDevice({
      devices,
      lastDevice: typeof last === 'string' ? last : undefined,
      lastWorkspace: () => undefined,
      workspaces: () => undefined,
    }) ?? ''
  )
}

export function managerWorkspace(
  deviceId: string,
  initial?: { deviceId?: string; workspaceId?: string | null },
): string {
  // 侧栏普通新建草稿会带 null/空串：它们表示入口没有指定项目，不是清除经理偏好。
  if (initial?.deviceId === deviceId && initial.workspaceId) return initial.workspaceId
  const id = stored(deviceId).workspaceId
  return typeof id === 'string' ? id : ''
}

/** 只由创建成功的分支调用；不保存名称、首个任务、权限或服务端身份字段。 */
export function rememberManager(
  deviceId: string,
  workspaceId: string,
  form: ManagerFormDraft,
): void {
  const { cwd, harness, model, effort, dispatch, contact, rules } = form
  saveRemembered(defaultsKey(deviceId), {
    workspaceId,
    cwd,
    harness,
    model,
    effort,
    dispatch,
    contact,
    rules,
  })
  writeRemembered(DEVICE_KEY, 'id', deviceId)
}

export function recallManager(
  device: DeviceView | undefined,
  base: ManagerFormDraft,
): ManagerFormDraft {
  const last = stored(device?.id ?? '')
  const dispatch = last.dispatch
  const contact = last.contact
  const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback)
  const nullable = (value: unknown) => (typeof value === 'string' && value ? value : null)
  return fitManagerHarness(
    {
      ...base,
      cwd: text(last.cwd, base.cwd),
      harness: text(last.harness, base.harness),
      model: nullable(last.model),
      effort: nullable(last.effort),
      rules: text(last.rules, base.rules),
      dispatch: {
        ...base.dispatch,
        harness: nullable(dispatch?.harness),
        model: nullable(dispatch?.model),
        effort: nullable(dispatch?.effort),
        worktree:
          typeof dispatch?.worktree === 'boolean' ? dispatch.worktree : base.dispatch.worktree,
        merge:
          dispatch?.merge === 'user' || dispatch?.merge === 'manager'
            ? dispatch.merge
            : base.dispatch.merge,
        maxRunningLines:
          dispatch && Number.isSafeInteger(dispatch.maxRunningLines) && dispatch.maxRunningLines > 0
            ? dispatch.maxRunningLines
            : base.dispatch.maxRunningLines,
      },
      contact: {
        ...base.contact,
        desktopNotification:
          typeof contact?.desktopNotification === 'boolean'
            ? contact.desktopNotification
            : base.contact.desktopNotification,
      },
    },
    device,
  )
}

/** harness 失效时整组模型参数放下，不能把另一个 harness 的同名模型误带过去。 */
export function fitManagerHarness(
  form: ManagerFormDraft,
  device: DeviceView | undefined,
): ManagerFormDraft {
  const ready = device?.harnesses.filter((entry) => entry.state === 'ready') ?? []
  const harness = defaultHarness(ready, [form.harness])?.id ?? ''
  const dispatch = form.dispatch
  const lineInvalid = dispatch.harness
    ? !ready.some((entry) => entry.id === dispatch.harness)
    : harness !== form.harness
  return {
    ...form,
    harness,
    ...(harness !== form.harness ? { model: null, effort: null } : {}),
    dispatch: lineInvalid ? { ...dispatch, harness: null, model: null, effort: null } : dispatch,
  }
}

/** 清单尚未回来时保留原选择；回来后再校验，提交前也使用同一份有效参数。 */
export function fitManagerModels(
  form: ManagerFormDraft,
  options: ComposeOptions | null,
  lineOptions: ComposeOptions | null,
): ManagerFormDraft {
  const fit = (
    model: string | null,
    effort: string | null,
    catalog: ComposeOptions | null,
    inherited?: string | null,
  ) => {
    if (!catalog) return { model, effort }
    if (model && !catalog.models.some((entry) => entry.id === model))
      return { model: null, effort: null }
    const picks = fitPicks({ model, effort }, catalog)
    const effective = catalog.models.find((entry) =>
      model || inherited ? entry.id === (model || inherited) : entry.isDefault,
    )
    return {
      model: picks.model ?? null,
      effort: effective?.efforts.find((entry) => entry.id === picks.effort)?.id ?? null,
    }
  }
  const own = fit(form.model, form.effort, options)
  const same = !form.dispatch.harness || form.dispatch.harness === form.harness
  return {
    ...form,
    ...own,
    dispatch: {
      ...form.dispatch,
      ...fit(form.dispatch.model, form.dispatch.effort, lineOptions, same ? own.model : null),
    },
  }
}
