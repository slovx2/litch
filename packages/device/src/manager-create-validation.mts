import { accessSync, constants, realpathSync } from 'node:fs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import type {
  Manager,
  ManagerCreateParams,
  ManagerResetCandidate,
  ManagerResetIssue,
  ManagerResetPreview,
  ManagerResetTarget,
} from '../../protocol/src/manager.mjs'
import { managerSelectionIssue } from '../../protocol/src/manager-validation.mjs'
import { supportsNativeBackground } from '../../protocol/src/native-background-wake.mjs'
import { permissionLevel } from '../../protocol/src/project-permissions.mjs'
import { requireDeviceDirectory } from './directory-validation.mjs'
import type { EngineLink } from './engine-link.mjs'
import { managerBundle, managerFingerprint } from './manager-rules.mjs'
import { fields, invalidSetting, keys, text, validatePatch } from './manager-validate.mjs'
import { type CatalogModel, modelCatalog } from './session-options.mjs'
import { currentPermission } from './session-permissions.mjs'
import type { SessionTree } from './session-tree.mjs'
import { isObject } from './wire.mjs'

/** 提交时再核对一次：用户停在表单期间，引擎配置或型号目录可能已经改变。 */
export async function validateManagerRuntime(
  tree: SessionTree,
  params: ManagerCreateParams,
): Promise<void> {
  const same = !params.dispatch.harness || params.dispatch.harness === params.harness
  const targets = [
    { prefix: '', harness: params.harness, model: params.model, effort: params.effort },
    {
      prefix: 'dispatch.',
      harness: params.dispatch.harness ?? params.harness,
      model: params.dispatch.model ?? (same ? params.model : null),
      effort: params.dispatch.effort,
    },
  ]
  for (const target of targets) {
    let link: EngineLink
    try {
      link = await tree.link(target.harness)
    } catch (error) {
      invalidSetting({
        field: `${target.prefix}harness`,
        reason: 'unavailableHarness',
        message: String(error),
      })
    }
    if (!target.model && !target.effort) continue
    let catalog: CatalogModel[]
    try {
      catalog = (await modelCatalog(link)).filter((entry) => !entry.hidden)
    } catch (error) {
      invalidSetting({
        field: `${target.prefix}model`,
        reason: 'catalogUnavailable',
        message: String(error),
      })
    }
    const issue = managerSelectionIssue(catalog, target.model, target.effort, target.prefix)
    if (issue) invalidSetting(issue)
  }
}

/** 源设置只从原引擎读取；目标工具和配置独立生成，不能跨引擎复制 provider 或审批对象。 */
export interface ManagerResetPlan extends ManagerResetPreview {
  sourceConfig: Record<string, unknown>
  managerSnapshot: Manager
  targetConfig: { modelProvider?: string; serviceTier?: string }
}
export function managerResetScheduleIssues(
  tree: SessionTree,
  threadId: string,
): ManagerResetIssue[] {
  try {
    return (tree.host.managerResetTasks?.(threadId) ?? []).map((task) => ({
      code: 'scheduledTasks',
      field: 'tasks',
      message: `Scheduled task “${task.name}” (${task.id}) still targets this manager or has an unfinished run. End or remove it in task management before switching.`,
    }))
  } catch (error) {
    return [
      {
        code: 'sourceStateUnknown',
        field: 'tasks',
        message: `Cannot verify scheduled tasks: ${String(error)}`,
      },
    ]
  }
}

export function resetTarget(value: unknown): ManagerResetTarget {
  const target = fields(value)
  keys(target, ['harness', 'model', 'effort', 'permission', 'dispatch'])
  text(target.harness, 'target.harness')
  text(target.permission, 'target.permission')
  for (const key of ['model', 'effort'])
    if (target[key] !== null) text(target[key], `target.${key}`)
  if (target.dispatch !== undefined) validatePatch({ dispatch: target.dispatch })
  return target as unknown as ManagerResetTarget
}

function capabilityReasons(link: EngineLink): ManagerResetCandidate['reasons'] {
  const features = isObject(link.runtime?.features) ? link.runtime.features : {}
  if (link.harness === 'dsh' || link.harness === 'acp')
    return [
      {
        code: 'unsupportedManagerCapabilities',
        field: 'harness',
        message:
          'This harness does not provide the required scoped questions and verified persistent manager handover. It is disabled as a takeover target.',
      },
    ]
  if (link.harness !== 'codex' && link.harness !== 'claude-code')
    return [
      {
        code: 'notValidated',
        field: 'harness',
        message: 'This harness has not passed manager handover acceptance.',
      },
    ]
  if (link.harness === 'codex' && !link.native)
    return [
      {
        code: 'unsupportedBackend',
        field: 'harness',
        message: 'Only the native Codex app-server is supported.',
      },
    ]
  if (
    link.harness === 'claude-code' &&
    (!Array.isArray(link.runtime?.extensions) ||
      !link.runtime.extensions.includes(EXTENSION.clientTools) ||
      features.ephemeralFork !== true ||
      features.backgroundTasks !== true ||
      features.steer !== true)
  )
    return [
      {
        code: 'unsupportedBackend',
        field: 'harness',
        message:
          'Manager handover requires the Claude Code SDK backend and its device tool capabilities.',
      },
    ]
  return []
}

async function resetCandidate(tree: SessionTree, harness: string, permission: string | null) {
  const candidate: ManagerResetCandidate = {
    harness,
    enabled: false,
    reasons: [],
    models: [],
    defaultModel: null,
    permissions: [],
  }
  let link: EngineLink | undefined
  let catalog: CatalogModel[] = []
  let defaultEffort: string | null = null
  let config: ManagerResetPlan['targetConfig'] = {}
  try {
    link = await tree.link(harness)
    candidate.reasons.push(...capabilityReasons(link))
    candidate.permissions = Array.isArray(link.runtime?.permissionPresets)
      ? link.runtime.permissionPresets.flatMap((preset) =>
          isObject(preset) && typeof preset.id === 'string' ? [preset.id] : [],
        )
      : []
    if (!permission || !candidate.permissions.includes(permission))
      candidate.reasons.push({
        code: 'unsupportedPermission',
        field: 'permission',
        message:
          'The target does not support the current built-in permission; permission changes require a separate action.',
      })
    catalog = (await modelCatalog(link)).filter((entry) => !entry.hidden)
    candidate.models = catalog.map(({ id, name, efforts, defaultEffort }) => ({
      id,
      name,
      efforts,
      defaultEffort,
    }))
    candidate.defaultModel = (catalog.find((entry) => entry.isDefault) ?? catalog[0])?.id ?? null
    if (!catalog.length)
      candidate.reasons.push({
        code: 'catalogUnavailable',
        field: 'model',
        message: 'No authenticated target models are available.',
      })
    if (link.native) {
      const settings = await link.request('config/read', { includeLayers: false })
      if (!isObject(settings?.config)) throw new Error('Target configuration is unavailable.')
      if (typeof settings.config.model === 'string') {
        const current = catalog.find(
          (entry) => entry.id === settings.config.model || entry.alias === settings.config.model,
        )
        candidate.defaultModel = current?.id ?? settings.config.model
      }
      defaultEffort =
        typeof settings.config.model_reasoning_effort === 'string'
          ? settings.config.model_reasoning_effort
          : null
      config = {
        ...(typeof settings.config.model_provider === 'string'
          ? { modelProvider: settings.config.model_provider }
          : {}),
        ...(typeof settings.config.service_tier === 'string'
          ? { serviceTier: settings.config.service_tier }
          : {}),
      }
    }
    candidate.enabled = !candidate.reasons.length
  } catch (error) {
    candidate.reasons.push({
      code: link ? 'catalogUnavailable' : 'unavailableHarness',
      field: link ? 'model' : 'harness',
      message: String(error),
    })
  }
  return { candidate, link, catalog, config, defaultEffort }
}

export async function managerResetPlan(
  tree: SessionTree,
  manager: Manager,
  requested?: ManagerResetTarget,
): Promise<ManagerResetPlan> {
  const sourceLink = await tree.link(manager.harness)
  const config = await tree.managers?.resets.readSettings(manager)
  if (!config) throw new Error('The source manager settings are unavailable.')
  const source = {
    harness: manager.harness,
    model:
      typeof config.model === 'string'
        ? config.model
        : config.model === null
          ? null
          : manager.model,
    effort:
      typeof config.reasoningEffort === 'string'
        ? config.reasoningEffort
        : config.reasoningEffort === null
          ? null
          : manager.effort,
    permission: currentPermission(config),
  }
  const results = await Promise.all(
    tree.host.harnesses().map(({ id }) => resetCandidate(tree, id, source.permission)),
  )
  const sourceCatalog =
    results.find(({ candidate }) => candidate.harness === source.harness)?.catalog ?? []
  const sourceRow = source.model
    ? sourceCatalog.find((entry) => entry.id === source.model || entry.alias === source.model)
    : (sourceCatalog.find((entry) => entry.isDefault) ?? sourceCatalog[0])
  source.model = sourceRow?.id ?? source.model
  source.effort ??= sourceRow?.defaultEffort ?? null
  const target = requested ?? { ...source, permission: source.permission ?? '' }
  const selected = results.find(({ candidate }) => candidate.harness === target.harness)
  const catalog = selected?.catalog ?? []
  const row = target.model
    ? catalog.find((entry) => entry.id === target.model)
    : catalog.find((entry) => entry.id === selected?.candidate.defaultModel)
  const resolved: ManagerResetTarget = {
    ...target,
    model: row?.id ?? target.model ?? selected?.candidate.defaultModel ?? null,
    effort:
      target.effort ??
      (row?.id === selected?.candidate.defaultModel ? selected?.defaultEffort : null) ??
      row?.defaultEffort ??
      null,
  }
  const mode =
    source.harness === 'claude-code' &&
    source.harness === resolved.harness &&
    source.model === resolved.model &&
    source.effort === resolved.effort
      ? 'refresh'
      : 'replace'
  const reasons = [
    ...(selected?.candidate.reasons ?? [
      {
        code: 'unavailableHarness',
        field: 'harness',
        message: 'The target harness is not configured on this device.',
      },
    ]),
  ]
  const issue = managerSelectionIssue(catalog, resolved.model, resolved.effort)
  if (issue) reasons.push({ code: issue.reason, field: issue.field, message: issue.message })
  if (resolved.harness === 'claude-code' && row && !row.id.includes('/') && !row.identity?.provider)
    reasons.push({
      code: 'ambiguousProvider',
      field: 'model',
      message: 'The target model catalogue does not identify its provider unambiguously.',
    })
  if (manager.status !== 'active')
    reasons.push({
      code: 'managerEnded',
      field: 'managerId',
      message: 'Only an active manager can be reset.',
    })
  if (source.permission !== target.permission || !permissionLevel(source.permission))
    reasons.push({
      code: 'permissionMismatch',
      field: 'permission',
      message: 'The current effective built-in permission is fixed during handover.',
    })
  if (source.harness !== resolved.harness && isObject(config.approvalPolicy))
    reasons.push({
      code: 'unsupportedPermission',
      field: 'permission',
      message:
        'The source uses a custom approval policy that cannot be compared with the target harness.',
    })
  if (tree.store.parentOf(manager.threadId))
    reasons.push({
      code: 'parentedManager',
      field: 'managerId',
      message: 'Resolve the manager parent relationship before switching.',
    })
  let directory: string | null = null
  const sourceFeatures = isObject(sourceLink.runtime?.features)
    ? { ...sourceLink.runtime.features }
    : {}
  if (mode === 'replace' && sourceFeatures.goals === true) {
    try {
      const result = await sourceLink.request('thread/goal/get', { threadId: manager.threadId })
      if (result.goal && !['complete', 'cleared', 'paused'].includes(result.goal.status))
        reasons.push({
          code: 'activeGoal',
          message: 'Pause or complete the source manager goal before switching.',
        })
    } catch (error) {
      reasons.push({
        code: 'sourceStateUnknown',
        message: `Cannot verify the source goal: ${String(error)}`,
      })
    }
  }
  try {
    directory = realpathSync(requireDeviceDirectory(manager.cwd))
    accessSync(directory, constants.R_OK | constants.X_OK)
  } catch (error) {
    reasons.push({ code: 'invalidDirectory', field: 'cwd', message: String(error) })
  }
  const dispatch = target.dispatch ?? manager.dispatch
  const dispatchHarness = dispatch.harness ?? target.harness
  if (dispatch.model || dispatch.effort) {
    const options = results.find(({ candidate }) => candidate.harness === dispatchHarness)
    const issue = managerSelectionIssue(
      options?.catalog ?? [],
      dispatch.model ?? (dispatchHarness === target.harness ? resolved.model : null),
      dispatch.effort,
      'dispatch.',
    )
    if (issue)
      reasons.push({ code: 'dispatchConflict', field: issue.field, message: issue.message })
  }
  const effective = (settings: typeof source, defaults: Manager['dispatch']) => ({
    harness: defaults.harness ?? settings.harness,
    model:
      defaults.model ??
      (!defaults.harness || defaults.harness === settings.harness ? settings.model : null),
    effort:
      defaults.effort ??
      (!defaults.harness || defaults.harness === settings.harness ? settings.effort : null),
  })
  const before = effective(source, manager.dispatch)
  const after = effective(resolved, dispatch)
  const capabilities = (link?: EngineLink) =>
    isObject(link?.runtime?.features) ? { ...link.runtime.features } : {}
  const targetFeatures = capabilities(selected?.link)
  const environment = tree.host.managerResetEnvironment?.()
  const background = (link?: EngineLink) =>
    link?.native === true &&
    supportsNativeBackground(link.runtime?.cliBuild) &&
    isObject(environment) &&
    environment.backgroundWake === true
  sourceFeatures.nativeBackground = background(sourceLink)
  targetFeatures.nativeBackground = background(selected?.link)
  const capabilityChanges = [
    'goals',
    'managerQuestions',
    'ephemeralFork',
    'backgroundTasks',
    'steer',
    'nativeBackground',
  ].flatMap((capability) =>
    (sourceFeatures[capability] === true) === (targetFeatures[capability] === true)
      ? []
      : [
          {
            capability,
            before: sourceFeatures[capability] === true,
            after: targetFeatures[capability] === true,
          },
        ],
  )
  if (mode === 'replace') reasons.push(...managerResetScheduleIssues(tree, manager.threadId))
  const targetManager = { ...manager, ...resolved, dispatch }
  const tools = tree.host.refreshClientTools(
    target.harness,
    managerBundle(
      targetManager,
      selected?.link?.native ?? false,
      tree.host.taskCards(target.harness),
    ),
  )
  const expectedSettingsHash = managerFingerprint({
    manager,
    source,
    directory,
    sourceConfig: {
      approvalPolicy: config.approvalPolicy,
      modelProvider: config.modelProvider,
      serviceTier: config.serviceTier,
    },
    target: resolved,
    dispatch,
    catalog,
    sourceCatalog,
    targetConfig: selected?.config,
    targetDefaults: { model: selected?.candidate.defaultModel, effort: selected?.defaultEffort },
    sourceRuntime: sourceLink.runtime,
    targetRuntime: selected?.link?.runtime,
    tools,
    environment,
  })
  return {
    managerId: manager.id,
    cwd: manager.cwd,
    expectedThreadId: manager.threadId,
    expectedSettingsHash,
    source,
    target: resolved,
    mode,
    canSubmit: !reasons.length,
    reasons,
    candidates: results.map(({ candidate }) => candidate),
    capabilityChanges,
    dispatchChanges: (['harness', 'model', 'effort'] as const).flatMap((field) =>
      before[field] === after[field] ? [] : [{ field, before: before[field], after: after[field] }],
    ),
    sourceConfig: Object.fromEntries(
      [
        'model',
        'reasoningEffort',
        'activePermissionProfile',
        'sandbox',
        'approvalPolicy',
        'modelProvider',
        'serviceTier',
      ]
        .filter((key) => config[key] !== undefined)
        .map((key) => [key, config[key]]),
    ),
    managerSnapshot: manager,
    targetConfig: selected?.config ?? {},
  }
}
