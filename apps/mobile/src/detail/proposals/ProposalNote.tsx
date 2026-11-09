import { useRef } from 'react'
import { Platform } from 'react-native'
import { submitQuestionOnEnter } from '../../../../../packages/ui/src/manager/post-presentation.ts'
import { useT } from '../../ui/i18n'
import { Field } from '../../ui/kit/controls'

/** Web 的硬件键盘保留 Shift+Enter；原生软键盘提供开始动作，多行仍可粘贴。 */
export function ProposalNote({
  value,
  onChange,
  disabled,
  onStart,
}: {
  value: string
  onChange(value: string): void
  disabled: boolean
  onStart(): void
}) {
  const t = useT()
  const skipSubmit = useRef(false)
  return (
    <Field
      label={t('proposal.note')}
      accessibilityLabel={t('proposal.note')}
      testID="proposal-note"
      value={value}
      onChangeText={onChange}
      editable={!disabled}
      multiline
      numberOfLines={2}
      style={{ minHeight: 64 }}
      returnKeyType="send"
      submitBehavior={Platform.OS === 'web' ? 'newline' : 'submit'}
      onSubmitEditing={() => {
        if (!disabled && !skipSubmit.current) onStart()
      }}
      onKeyPress={(event) => {
        const key = event.nativeEvent as typeof event.nativeEvent & {
          shiftKey?: boolean
          isComposing?: boolean
          keyCode?: number
        }
        skipSubmit.current = Boolean(key.shiftKey || key.isComposing || key.keyCode === 229)
        if (
          Platform.OS !== 'web' ||
          disabled ||
          !submitQuestionOnEnter({
            key: key.key,
            shiftKey: key.shiftKey ?? false,
            isComposing: key.isComposing ?? false,
            keyCode: key.keyCode ?? 0,
          })
        )
          return
        event.preventDefault()
        onStart()
      }}
    />
  )
}
