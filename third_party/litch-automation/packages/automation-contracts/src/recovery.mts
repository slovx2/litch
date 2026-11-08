/** 给代理的恢复建议；retryable 只表示完成 next_action 后可重试，不授权重放输入。 */
export interface AutomationRecovery {
  status: 'error' | 'waiting_for_user'
  retryable: boolean
  needs_snapshot: boolean
  needs_claim: boolean
  needs_approval: boolean
  may_have_executed: boolean
  next_action:
    | 'snapshot'
    | 'ensure_claimed'
    | 'wait_for_user'
    | 'wait_for_load'
    | 'inspect_result'
    | 'fix_arguments'
  hint: string
}

export function automationRecovery(
  code: string,
  message = '',
  mayHaveExecuted?: boolean,
): AutomationRecovery {
  const result: AutomationRecovery = {
    status: 'error',
    retryable: false,
    needs_snapshot: false,
    needs_claim: false,
    needs_approval: false,
    may_have_executed: mayHaveExecuted ?? true,
    next_action: 'inspect_result',
    hint: 'Inspect the current result before continuing; do not replay input blindly.',
  }
  // 用户闸门先于文档/租约；错误文本只用于旧宿主的非结构化异常。
  if (
    ['signingIn', 'userStopped', 'originNotApproved', 'permission', 'declined'].includes(code) ||
    /signing in|declined|blocklist|user stopped|permission|secure prompt|computer is locked/i.test(
      message,
    )
  ) {
    return {
      ...result,
      status: 'waiting_for_user',
      needs_approval: true,
      next_action: 'wait_for_user',
      hint: 'Wait for the user to finish sign-in, grant access or resume control. Do not poll, reclaim or bypass a refusal.',
    }
  }
  if (['staleLease', 'tabNotClaimed', 'disconnected'].includes(code)) {
    return {
      ...result,
      retryable: true,
      needs_claim: true,
      next_action: 'ensure_claimed',
      hint: 'Call ensure_claimed for the same Chrome tab, then inspect its fresh snapshot. Do not repeat prior input.',
    }
  }
  if (
    ['staleRef', 'staleDocument'].includes(code) ||
    /unknown ref|element is gone|document changed|fresh snapshot|new `snapshot`|call get_app_state|element.*not found/i.test(
      message,
    )
  ) {
    return {
      ...result,
      retryable: true,
      needs_snapshot: true,
      next_action: 'snapshot',
      hint: 'Take a fresh snapshot/get_app_state and use only its current refs. Continue only unfinished work.',
    }
  }
  if (code === 'notDispatched') {
    return {
      ...result,
      retryable: true,
      may_have_executed: mayHaveExecuted ?? false,
      next_action: 'wait_for_load',
      needs_snapshot: true,
      hint: 'No input was dispatched. Wait for load, take a fresh snapshot, then retry only this step.',
    }
  }
  if (code === 'invalid')
    return {
      ...result,
      next_action: 'fix_arguments',
      hint: 'Correct the arguments using the latest observation before continuing.',
    }
  return result
}
