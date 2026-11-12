import { useEffect, useRef } from 'react'
import { Platform, type TextInput } from 'react-native'
import { submitQuestionOnEnter } from '../../../../../packages/ui/src/manager/post-presentation.ts'
import { useT } from '../../ui/i18n'
import { Field } from '../../ui/kit/controls'

/** Web 的硬件键盘保留 Shift+Enter；原生软键盘提供开始动作，多行仍可粘贴。 */
export function ProposalNote({
  value,
  onChange,
  disabled,
  onStart,
  focus = false,
}: {
  value: string
  onChange(value: string): void
  disabled: boolean
  onStart(): void
  /** 刚点“补充说明”展开：挂上后直接进入输入 */
  focus?: boolean
}) {
  const t = useT()
  const skipSubmit = useRef(false)
  const box = useRef<TextInput>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂上时取一次焦点
  useEffect(() => {
    if (focus) box.current?.focus()
  }, [])
  return (
    <Field
      ref={box}
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
