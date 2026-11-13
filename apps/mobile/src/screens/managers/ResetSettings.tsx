import type { ManagerResetPreview, ManagerResetTarget, ManagerView } from '@litch/core'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { ChoiceMark } from '../../ui/kit/marks'
import { Dialog } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import {
  resetEffortLabel,
  resetNextTarget,
  resetPermissionLabel,
  resetSettingsLabel,
} from './reset'

/** 独立、可滚动的接班表单；确认框只负责最终有损确认。 */
export function ResetSettings({
  visible,
  manager,
  preview,
  busy,
  error,
  onChange,
  onRetry,
  onConfirm,
  onClose,
  onDismiss,
}: {
  visible: boolean
  manager: ManagerView
  preview: ManagerResetPreview | null
  busy: boolean
  error: string
  onChange(target: ManagerResetTarget): void
  onRetry(): void
  onConfirm(): void
  onClose(): void
  onDismiss?(): void
}) {
  const t = useT()
  const { c, font, hit, radius } = useTheme()
  const target = preview?.target
  const candidate = preview?.candidates.find((one) => one.harness === target?.harness)
  const model = candidate?.models.find((one) => one.id === target?.model)
  const change = (patch: Partial<ManagerResetTarget>) => {
    if (preview) onChange(resetNextTarget(preview, patch))
  }
  const title = (label: string) => (
    <Text style={{ color: c.ink, fontSize: font.size.body, fontWeight: '600' }}>{label}</Text>
  )
  const option = (
    id: string,
    label: string,
    selected: boolean,
    onPress: () => void,
    reason = '',
  ) => (
    <Pressable
      key={id}
      testID={id}
      accessibilityRole="radio"
      accessibilityLabel={[label, reason].filter(Boolean).join(' · ')}
      aria-checked={selected}
      aria-disabled={busy || !!reason}
      disabled={busy || !!reason}
      onPress={onPress}
      style={[
        styles.option,
        {
          minHeight: hit,
          borderRadius: radius.m,
          borderColor: selected ? c.accent : c.line2,
          backgroundColor: selected ? c.sunken : c.panel,
        },
      ]}
    >
      <View style={styles.optionLabel}>
        <ChoiceMark kind="radio" state={selected ? 'on' : 'off'} />
        <Text style={{ color: reason ? c.ink3 : c.ink, fontSize: font.size.body, flexShrink: 1 }}>
          {label}
        </Text>
      </View>
      {reason ? <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{reason}</Text> : null}
    </Pressable>
  )
  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      footer={
        <View style={styles.buttons}>
          <Button kind="quiet" label={t('app.cancel')} onPress={onClose} />
          <Button
            label={t('manager.resetReview')}
            testID="manager-reset-next"
            busy={busy}
            disabled={!preview?.canSubmit || !!error}
            onPress={onConfirm}
          />
        </View>
      }
    >
      <View testID="manager-reset-settings" style={styles.body}>
        {title(t('manager.resetSettings'))}
        <Text style={{ color: c.ink2 }}>{t('manager.resetSettingsHint')}</Text>
        <Text style={{ color: c.ink2 }}>
          {[t('manager.resetFixed'), manager.deviceId, manager.cwd].join('\n')}
        </Text>
        {preview ? (
          <>
            <Text style={{ color: c.ink2 }}>
              {t('manager.resetSource')}: {resetSettingsLabel(preview.source, t)}
            </Text>
            {title(t('manager.resetTarget'))}
            {preview.candidates.map((one) =>
              option(
                `manager-reset-harness:${one.harness}`,
                resetSettingsLabel(
                  { harness: one.harness, model: null, effort: null, permission: null },
                  t,
                ),
                one.harness === target?.harness,
                () => change({ harness: one.harness }),
                !one.enabled
                  ? one.reasons
                      .map((issue) =>
                        issue.code === 'notValidated'
                          ? t('manager.resetNotValidated')
                          : issue.message,
                      )
                      .join('\n') || t('manager.resetUnavailable')
                  : '',
              ),
            )}
            {title(t('manager.model'))}
            {candidate?.models.map((one) =>
              option(`manager-reset-model:${one.id}`, one.name, one.id === target?.model, () =>
                change({ model: one.id }),
              ),
            )}
            {title(t('manager.effort'))}
            {model?.efforts.length ? (
              model.efforts.map((effort) =>
                option(
                  `manager-reset-effort:${effort}`,
                  resetEffortLabel(effort, t),
                  effort === target?.effort,
                  () => change({ effort }),
                ),
              )
            ) : (
              <Text style={{ color: c.ink2 }}>{t('manager.resetNoEffort')}</Text>
            )}
            <Text style={{ color: c.ink2 }}>
              {t('manager.resetPermission')}: {resetPermissionLabel(target?.permission ?? null, t)}
            </Text>
            <Text style={{ color: c.ink2 }}>
              {t(
                target?.harness === 'claude-code'
                  ? 'manager.resetPermissionClaude'
                  : 'manager.resetPermissionCodex',
              )}
            </Text>
            {title(t('manager.dispatch'))}
            <Text style={{ color: c.ink2 }}>{t('manager.resetDispatchNote')}</Text>
            {(() => {
              const dispatch = target?.dispatch ?? manager.dispatch
              const setDispatch = (patch: Partial<typeof dispatch>) =>
                change({ dispatch: { ...dispatch, ...patch } })
              const harnesses = [
                ...new Set([
                  preview.source.harness,
                  ...preview.candidates.filter((one) => one.enabled).map((one) => one.harness),
                  ...(dispatch.harness ? [dispatch.harness] : []),
                ]),
              ]
              const models =
                preview.candidates.find(
                  (one) => one.harness === (dispatch.harness ?? target?.harness),
                )?.models ?? []
              const dispatchModel = models.find(
                (one) => one.id === (dispatch.model ?? target?.model),
              )
              return (
                <>
                  {title(t('manager.lineHarness'))}
                  {option(
                    'manager-reset-dispatch:follow',
                    t('manager.same'),
                    dispatch.harness === null,
                    () => setDispatch({ harness: null }),
                  )}
                  {harnesses.map((harness) =>
                    option(
                      `manager-reset-dispatch-harness:${harness}`,
                      resetSettingsLabel(
                        { harness, model: null, effort: null, permission: null },
                        t,
                      ),
                      dispatch.harness === harness,
                      () => setDispatch({ harness }),
                    ),
                  )}
                  {title(t('manager.model'))}
                  {option(
                    'manager-reset-dispatch:model-follow',
                    t('manager.same'),
                    dispatch.model === null,
                    () => setDispatch({ model: null, effort: null }),
                  )}
                  {models.map((one) =>
                    option(
                      `manager-reset-dispatch-model:${one.id}`,
                      one.name,
                      dispatch.model === one.id,
                      () => setDispatch({ model: one.id, effort: null }),
                    ),
                  )}
                  {dispatch.model && !models.some((one) => one.id === dispatch.model) ? (
                    <Text style={{ color: c.ink2 }}>{dispatch.model}</Text>
                  ) : null}
                  {title(t('manager.effort'))}
                  {option(
                    'manager-reset-dispatch:effort-follow',
                    t('manager.same'),
                    dispatch.effort === null,
                    () => setDispatch({ effort: null }),
                  )}
                  {dispatchModel?.efforts.map((effort) =>
                    option(
                      `manager-reset-dispatch-effort:${effort}`,
                      resetEffortLabel(effort, t),
                      dispatch.effort === effort,
                      () => setDispatch({ effort }),
                    ),
                  )}
                </>
              )
            })()}
            {preview.reasons.map((issue) => (
              <Text
                key={`${issue.code}:${issue.field}:${issue.message}`}
                accessibilityRole="alert"
                style={{ color: c.err }}
              >
                {issue.message}
              </Text>
            ))}
          </>
        ) : null}
        {busy ? (
          <Text accessibilityLiveRegion="polite" style={{ color: c.ink2 }}>
            {t('manager.resetPreviewLoading')}
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={{ color: c.err }}>
            {error}
          </Text>
        ) : null}
        {error ? (
          <Button
            kind="plain"
            label={t('manager.resetPreviewRetry')}
            onPress={onRetry}
            disabled={busy}
          />
        ) : null}
      </View>
    </Dialog>
  )
}

const styles = StyleSheet.create({
  body: { gap: 8 },
  option: { borderWidth: 1, padding: 8, gap: 4, justifyContent: 'center' },
  optionLabel: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-end' },
})
