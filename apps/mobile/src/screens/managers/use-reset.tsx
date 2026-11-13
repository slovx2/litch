import type { ManagerResetPreview, ManagerResetTarget, ManagerView } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { Platform, Text } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Confirm, type SheetAction } from '../../ui/kit/overlays'
import type { HeaderAction } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { ResetSettings } from './ResetSettings'
import {
  managerResetState,
  resetPreviewDetail,
  resetSettingsLabel,
  resetTargetParams,
} from './reset'

export function useManagerReset(manager: ManagerView, online: boolean, resetTarget = false) {
  const channel = useChannel()
  const t = useT()
  const { c } = useTheme()
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState(false)
  const [preview, setPreview] = useState<ManagerResetPreview | null>(null)
  const [checking, setChecking] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const revision = useRef(0)
  const selected = useRef<ManagerResetTarget | undefined>(undefined)
  const requestId = useRef('')
  const confirmAfterDismiss = useRef(false)
  const phase = manager.reset?.phase
  const previous = useRef(phase)
  useEffect(() => {
    if (
      previous.current !== phase &&
      ['failed', 'summaryFailed'].includes(phase ?? '') &&
      !(resetTarget && phase === 'failed')
    )
      setOpen(true)
    previous.current = phase
  }, [phase, resetTarget])
  useEffect(
    () => () => {
      revision.current += 1
    },
    [],
  )
  const state = managerResetState(manager, online, sending)
  const operation = resetTarget ? manager.reset?.operation : undefined
  const locked = state.boardOnly && !!operation
  // 其他客户端发起的普通重置可能没有目标记录，摘要失败仍按原流程再次确认。
  const targetFlow = resetTarget && (!state.boardOnly || !!operation)
  const check = async (target?: ManagerResetTarget) => {
    const version = ++revision.current
    selected.current = target
    setChecking(true)
    setError('')
    try {
      const plan = await channel.command('managers.reset.preview', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        ...(target ? { target } : {}),
      })
      if (version === revision.current) {
        setPreview(plan)
        selected.current = plan.target
      }
    } catch (cause) {
      if (version === revision.current) setError(whyNot(cause, t))
    } finally {
      if (version === revision.current) setChecking(false)
    }
  }
  const begin = () => {
    setError('')
    if (targetFlow && !locked) {
      setPreview(null)
      setSettings(true)
      void check()
    } else setOpen(true)
  }
  const submit = async () => {
    if (state.disabled || submitting.current || (targetFlow && !locked && !preview?.canSubmit))
      return
    submitting.current = true
    setSending(true)
    setError('')
    try {
      await channel.command(
        'managers.reset',
        targetFlow
          ? resetTargetParams(manager, preview, requestId.current)
          : {
              deviceId: manager.deviceId,
              managerId: manager.id,
              ...(state.boardOnly ? { boardOnly: true } : {}),
            },
      )
    } catch (cause) {
      setError(whyNot(cause, t))
      // 旧确认已经过期时必须重新预检，不能把失败请求降成普通重置。
      if (targetFlow && !locked) setSettings(true)
      else setOpen(true)
    } finally {
      submitting.current = false
      setSending(false)
    }
  }
  const action: SheetAction = {
    label: t(manager.reset?.outdated ? 'manager.resetOutdated' : 'manager.reset'),
    testID: 'manager:reset',
    ...(targetFlow ? { afterDismiss: true } : {}),
    ...(state.disabled ? { disabled: t(state.disabled) } : {}),
    onPress: begin,
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
  const replace = locked ? true : targetFlow && preview ? preview.mode === 'replace' : state.replace
  const target = locked ? operation?.target : preview?.target
  const source = locked ? operation?.source : preview?.source
  const changed =
    source &&
    target &&
    ['harness', 'model', 'effort'].some(
      (key) => source[key as keyof typeof source] !== target[key as keyof typeof target],
    )
  const detail =
    targetFlow && target
      ? [
          locked && operation
            ? [
                `${resetSettingsLabel(operation.source, t)} → ${resetSettingsLabel(target, t)}`,
                t('manager.resetTargetSummaryFailed', { target: resetSettingsLabel(target, t) }),
                t('manager.resetTargetLocked'),
                t('manager.resetTargetReplace'),
              ].join('\n\n')
            : preview
              ? resetPreviewDetail(preview, t)
              : '',
          error || manager.reset?.error || '',
        ]
          .filter(Boolean)
          .join('\n\n')
      : [
          t('manager.resetNote'),
          t(replace ? 'manager.resetReplace' : 'manager.resetRefresh'),
          state.boardOnly ? t('manager.resetSummaryFailed') : '',
          error || manager.reset?.error || '',
        ]
          .filter(Boolean)
          .join('\n\n')
  const active = ['waiting', 'summarizing', 'applying'].includes(phase ?? '')
  return {
    cancelActions,
    attention: state.attention,
    menu: manager.status === 'active' ? [action] : [],
    status:
      resetTarget && ((operation && active) || phase === 'failed' || state.handoverFailed) ? (
        <Text
          testID="manager-reset-status"
          accessibilityLiveRegion="polite"
          style={{ color: state.handoverFailed ? c.err : c.ink2, padding: 12 }}
        >
          {state.handoverFailed
            ? t('manager.resetHandoverFailed')
            : phase === 'failed'
              ? manager.reset?.error || t('manager.reset')
              : operation
                ? t('manager.resetTargetWaiting', {
                    source: resetSettingsLabel(operation.source, t),
                    target: resetSettingsLabel(operation.target, t),
                  })
                : ''}
          {operation && (phase === 'failed' || state.handoverFailed)
            ? `\n${resetSettingsLabel(operation.source, t)} → ${resetSettingsLabel(operation.target, t)}`
            : ''}
        </Text>
      ) : null,
    overlay: (
      <>
        <ResetSettings
          visible={settings}
          manager={manager}
          preview={preview}
          busy={checking}
          error={error}
          onChange={(target) => {
            void check(target)
          }}
          onRetry={() => {
            void check(selected.current)
          }}
          onConfirm={() => {
            if (!preview?.canSubmit || checking || error) return
            requestId.current = `manager-reset-${Date.now()}-${Math.random().toString(36).slice(2)}`
            // iOS 关闭一个原生 Modal 后才能呈现下一个，避免连带关闭确认框。
            confirmAfterDismiss.current = Platform.OS === 'ios'
            setSettings(false)
            if (!confirmAfterDismiss.current) setOpen(true)
          }}
          onDismiss={() => {
            if (confirmAfterDismiss.current) {
              confirmAfterDismiss.current = false
              setOpen(true)
            }
          }}
          onClose={() => {
            revision.current += 1
            setChecking(false)
            setSettings(false)
          }}
        />
        <Confirm
          visible={open}
          title={t(changed ? 'manager.resetSwitchTitle' : 'manager.reset')}
          detail={detail}
          confirmLabel={t(
            state.boardOnly
              ? 'manager.resetBoardOnly'
              : changed
                ? 'manager.resetSwitch'
                : 'manager.reset',
          )}
          danger={replace}
          onConfirm={() => {
            void submit()
          }}
          onClose={() => setOpen(false)}
        />
      </>
    ),
  }
}
