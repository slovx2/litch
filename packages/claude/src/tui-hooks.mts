/** 将既有宿主权限回调合并成唯一的命令 hook 决定，绝不让异常变成无决定。 */
export async function tuiHook(
  options: Record<string, any>,
  event: Record<string, any>,
  emit: (event: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const name = String(event.hook_event_name)
  const id = String(event.tool_use_id ?? '')
  const signal = options.abortController.signal as AbortSignal
  signal.throwIfAborted()
  if (name === 'PermissionRequest')
    return {
      hookSpecificOutput: {
        hookEventName: name,
        decision: {
          behavior: 'deny',
          message:
            '原生权限规则仍要求终端确认，TUI 后端已拒绝；请切回 SDK 或检查设备上的 Claude 权限规则',
        },
      },
    }
  const refuse = (reason: string): Record<string, unknown> => {
    emit({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, content: reason, is_error: true }],
      },
    })
    return deny(reason)
  }
  if (name === 'PreToolUse') {
    const tool = String(event.tool_name)
    // 原样 helper 的 JSONL 可能在工具完成后才交来；按调用 ID 复用实时投影的去重。
    emit({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: tool, input: event.tool_input }] },
    })
    if (tool === 'EnterPlanMode' || tool === 'ExitPlanMode')
      return refuse('TUI 后端暂不支持计划模式和计划确认；请切回 SDK')
    if (
      [
        'Agent',
        'Task',
        'Workflow',
        'PowerShell',
        'Monitor',
        'SendMessage',
        'ListAgents',
        'CronCreate',
        'CronDelete',
        'CronList',
        'ScheduleWakeup',
      ].includes(tool) ||
      event.tool_input?.run_in_background
    )
      return refuse('TUI 后端暂不支持子代理、后台任务、PowerShell 和会话间消息')
  }
  let input = event.tool_input
  for (const matcher of options.hooks?.[name] ?? []) {
    if (matcher.matcher && !new RegExp(`^(?:${matcher.matcher})$`).test(String(event.tool_name)))
      continue
    for (const callback of matcher.hooks) {
      const result = await callback({ ...event, tool_input: input }, id, { signal })
      signal.throwIfAborted()
      const specific = result?.hookSpecificOutput
      if (name === 'PreToolUse' && specific?.permissionDecision === 'deny')
        return refuse(specific.permissionDecisionReason ?? '宿主拒绝执行')
      if (specific?.updatedInput) input = specific.updatedInput
    }
  }
  if (name === 'PreToolUse') {
    const decision = await options.canUseTool(event.tool_name, input, { signal, toolUseID: id })
    signal.throwIfAborted()
    if (decision.behavior !== 'allow') {
      const reason = decision.message ?? '宿主未批准执行'
      const refused = refuse(reason)
      // SDK 的 interrupt 决定在命令 hook 中对应停止代理循环，不能只拒绝工具后继续请求模型。
      return decision.interrupt ? { ...refused, continue: false, stopReason: reason } : refused
    }
    return {
      hookSpecificOutput: {
        hookEventName: name,
        permissionDecision: 'allow',
        updatedInput: decision.updatedInput ?? input,
      },
    }
  }
  if (name === 'PostToolUse' || name === 'PostToolUseFailure') {
    emit({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: JSON.stringify(event.tool_response ?? event.error ?? ''),
            is_error: name === 'PostToolUseFailure',
          },
        ],
      },
      tool_use_result: event.tool_response,
    })
  }
  return {}
}

function deny(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}
