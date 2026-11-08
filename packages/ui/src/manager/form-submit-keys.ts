// 看板表单：单行 Enter，多行 Cmd/Ctrl+Enter。候选选择优先；输入法上屏不触发表单隐式提交。
import { type FormEvent, type KeyboardEvent, useRef } from 'react'
import { submitQuestionOnEnter } from './post-presentation.ts'

export function useBoardFormKeys(send: () => unknown) {
  const composing = useRef(false)
  const suppressed = useRef(false)
  const pending = useRef(false)
  const submit = async () => {
    if (composing.current || suppressed.current || pending.current) return
    pending.current = true
    try {
      await send()
    } finally {
      pending.current = false
    }
  }
  const suppressImplicit = () => {
    suppressed.current = true
    // 浏览器可能在 compositionend 之后把同一次 Enter 作为表单默认动作。
    setTimeout(() => {
      suppressed.current = false
    }, 0)
  }
  return {
    onCompositionStart: () => {
      composing.current = true
    },
    onCompositionEnd: () => {
      composing.current = false
      suppressImplicit()
    },
    onSubmit: (event: FormEvent) => {
      event.preventDefault()
      void submit()
    },
    onKeyDown: (event: KeyboardEvent<HTMLFormElement>) => {
      const field = event.target
      if (
        !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) ||
        event.key !== 'Enter'
      )
        return
      if (field.form !== event.currentTarget) return
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
        suppressImplicit()
        return
      }
      if (event.defaultPrevented) return
      // 路径、模型等候选列表里的回车由它自己的控件处理。
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        (field.getAttribute('role') === 'combobox' ||
          field.getAttribute('aria-expanded') === 'true')
      )
        return
      const multiline = field instanceof HTMLTextAreaElement
      if (!multiline && event.shiftKey) {
        event.preventDefault()
        return
      }
      if (!submitQuestionOnEnter(event.nativeEvent, multiline)) return
      event.preventDefault()
      if (field.value.trim()) void submit()
    },
  }
}
