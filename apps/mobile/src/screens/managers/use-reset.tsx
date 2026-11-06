import type { ManagerView } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Confirm, type SheetAction } from '../../ui/kit/overlays'
import type { HeaderAction } from '../../ui/kit/Screen'
import { managerResetState } from './reset'

export function useManagerReset(manager: ManagerView, online: boolean) {
  const channel = useChannel()
  const t = useT()
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const phase = manager.reset?.phase
  const previous = useRef(phase)
  useEffect(() => {
    if (previous.current !== phase && ['failed', 'summaryFailed'].includes(phase ?? ''))
      setOpen(true)
    previous.current = phase
  }, [phase])
  const state = managerResetState(manager, online, sending)
  const submit = async () => {
    if (state.disabled || submitting.current) return
    submitting.current = true
    setSending(true)
    setError('')
    try {
      await channel.command('managers.reset', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        ...(state.boardOnly ? { boardOnly: true } : {}),
      })
    } catch (cause) {
      setError(whyNot(cause, t))
      setOpen(true)
    } finally {
      submitting.current = false
      setSending(false)
    }
  }
  const action: SheetAction = {
    label: t(manager.reset?.outdated ? 'manager.resetOutdated' : 'manager.reset'),
    testID: 'manager:reset',
    ...(state.disabled ? { disabled: t(state.disabled) } : {}),
    onPress: () => {
      setError('')
      setOpen(true)
    },
  }
  const cancel = async () => {
    if (state.cancelDisabled || submitting.current) return
    submitting.current = true
    setSending(true)
    setError('')
    try {
      await channel.command('managers.reset.cancel', {
        deviceId: manager.deviceId,
        managerId: manager.id,
      })
    } catch (cause) {
      setError(whyNot(cause, t))
      setOpen(true)
    } finally {
      submitting.current = false
      setSending(false)
    }
  }
  const cancelActions: HeaderAction[] = state.cancellable
    ? [
        {
          icon: 'close',
          label: t('manager.resetCancel'),
          testID: 'manager:reset-cancel',
          disabled: state.cancelDisabled,
          onPress: () => {
            void cancel()
          },
        },
      ]
    : []
  return {
    cancelActions,
    attention: state.attention,
    menu: manager.status === 'active' ? [action] : [],
    overlay: (
      <Confirm
        visible={open}
        title={t('manager.reset')}
        detail={[
          t('manager.resetNote'),
          t(state.replace ? 'manager.resetReplace' : 'manager.resetRefresh'),
          state.boardOnly ? t('manager.resetSummaryFailed') : '',
          error || manager.reset?.error || '',
        ]
          .filter(Boolean)
          .join('\n\n')}
        confirmLabel={t(state.boardOnly ? 'manager.resetBoardOnly' : 'manager.reset')}
        danger={state.replace}
        onConfirm={() => {
          void submit()
        }}
        onClose={() => setOpen(false)}
      />
    ),
  }
}
