import type { ManagerValidationIssue } from '../../../protocol/src/manager-validation.mjs'
import { ChannelError } from '../channel/protocol.mjs'

const fields: Record<string, [string, string]> = {
  name: ['名称', 'Name'],
  scope: ['范围', 'Scope'],
  rules: ['经理设定', 'Manager instructions'],
  firstTask: ['首个任务', 'First task'],
  cwd: ['工作目录', 'Working directory'],
  harness: ['经理使用的 harness', 'Manager harness'],
  model: ['经理模型', 'Manager model'],
  effort: ['经理强度', 'Manager reasoning effort'],
  permission: ['访问权限', 'Permissions'],
  template: ['经理模板', 'Manager template'],
  dispatch: ['任务分配', 'Dispatch settings'],
  'dispatch.harness': ['子会话使用的 harness', 'Work line harness'],
  'dispatch.model': ['子会话模型', 'Work line model'],
  'dispatch.effort': ['子会话强度', 'Work line reasoning effort'],
  'dispatch.worktree': ['独立工作树', 'Separate worktree'],
  'dispatch.merge': ['合并方式', 'Merge policy'],
  'dispatch.maxRunningLines': ['最大并行工作线数', 'Maximum running work lines'],
  contact: ['联系方式', 'Contact settings'],
  'contact.desktopNotification': ['桌面通知', 'Desktop notifications'],
  'contact.unanswered': ['未答复时的处理方式', 'Unanswered decisions'],
}
const reasons: Record<ManagerValidationIssue['reason'], [string, string]> = {
  object: [
    '设置结构无效。请重新打开表单后填写。',
    'Invalid settings structure. Reopen the form and enter the settings again.',
  ],
  unknownField: [
    '设备不接受此字段。请升级设备服务和应用后重试。',
    'The device does not accept this field. Update the device service and app, then try again.',
  ],
  text: ['请输入文字。', 'Enter text.'],
  required: [
    '不能为空。请填写内容或重新选择。',
    'This value is required. Enter a value or select an option.',
  ],
  boolean: ['请选择是否启用。', 'Choose whether to enable this option.'],
  choice: ['选项无效。请重新选择。', 'Invalid option. Select an available option.'],
  positiveInteger: [
    '请输入大于 0 的整数（不超过 9007199254740991）。',
    'Enter an integer from 1 to 9007199254740991.',
  ],
  absolutePath: [
    '请输入目标设备上的绝对目录路径或以 ~/ 开头的路径，不能使用相对路径。',
    'Enter an absolute directory path on the target device or a path starting with ~/. Relative paths are not supported.',
  ],
  missingDirectory: [
    '目标设备上不存在此目录。请选择已有目录，或先在目标设备上创建目录。',
    'This directory does not exist on the target device. Select an existing directory or create it on that device first.',
  ],
  notDirectory: ['此路径指向文件。请选择目录。', 'This path is a file. Select a directory.'],
  unreadableDirectory: [
    '设备服务无法访问此目录。请检查目录权限或选择其他目录。',
    'The device service cannot access this directory. Check its permissions or select another directory.',
  ],
  unavailableHarness: [
    '目标设备未配置此 harness。请在设备详情中配置，或选择可用的 harness。',
    'This harness is not configured on the target device. Configure it in device details or select an available harness.',
  ],
  unsupportedPermission: [
    '当前 harness 不支持此权限。请选择支持的访问权限或其他 harness。',
    'This harness does not support these permissions. Select supported permissions or another harness.',
  ],
  unavailableModel: [
    '此模型已不可用。请重新选择模型或使用默认值。',
    'This model is no longer available. Select another model or use the default.',
  ],
  unsupportedEffort: [
    '所选模型不支持此强度。请重新选择强度或使用默认值。',
    'The selected model does not support this effort. Select a supported effort or use the default.',
  ],
  catalogUnavailable: [
    '无法读取目标 harness 的模型列表。请在设备详情中检查其连接与登录状态后重试。',
    'The model list could not be loaded. Check the harness connection and sign-in status in device details, then try again.',
  ],
}

export function managerValidationError(
  message: string,
  field?: string,
  reason?: string,
  path: { value?: string; resolvedPath?: string } = {},
): ChannelError {
  const label = field ? (fields[field] ?? [field, field]) : null
  const detail =
    field === 'contact.unanswered' && reason === 'choice'
      ? [
          '当前仅支持持续等待。请重新打开表单恢复默认值。',
          'Only waiting is supported. Reopen the form to restore the default.',
        ]
      : field === 'template' && reason === 'choice'
        ? ['模板无效。请重新打开新建表单。', 'Invalid template. Reopen the creation form.']
        : reason && Object.hasOwn(reasons, reason)
          ? reasons[reason as ManagerValidationIssue['reason']]
          : null
  const input = typeof path.value === 'string' ? path.value : null
  const resolved = typeof path.resolvedPath === 'string' ? path.resolvedPath : null
  return new ChannelError('invalid', message, undefined, {
    ...(field ? { key: field } : {}),
    said: {
      'zh-CN': `${label ? `${label[0]}：` : ''}${detail?.[0] ?? '设备未返回具体校验原因。请检查填写内容，并在设备详情里升级设备服务后重试。'}${input !== null ? ` 输入：${input}。` : ''}${resolved !== null ? ` 设备路径：${resolved}。` : ''}`,
      en: `${label ? `${label[1]}: ` : ''}${detail?.[1] ?? 'The device did not provide a validation reason. Check the form and upgrade the device service in device details, then try again.'}${input !== null ? ` Entered: ${input}.` : ''}${resolved !== null ? ` Device path: ${resolved}.` : ''}`,
    },
  })
}
