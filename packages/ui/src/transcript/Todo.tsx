// 待办进度：模型自己列的几步，做到哪了。
// 平时放在右边常驻的信息栏里（rail/InfoRail.tsx）；信息栏放不下的时候露在对话里，不跟着过程区收起来。
// 模型每改一次，核心把同一个条目整份换掉，这里原地重画：卡片在对话里的位置不变。
import type { TodoItem, TodoStep } from '@litch/core'
import { memo } from 'react'
import { useT } from '../app/appearance.ts'
import type { MessageKey } from '../i18n/index.ts'
import { type ItemRef, useItem } from './messages.tsx'

const STATUS: Record<TodoStep['status'], MessageKey> = {
  pending: 'todo.pending',
  inProgress: 'todo.inProgress',
  completed: 'todo.completed',
}

/** 做完几步、一共几步、正在做第几步（没有在做的是 -1） */
export function todoProgress(item: TodoItem): { done: number; total: number; current: number } {
  return {
    done: item.steps.filter((step) => step.status === 'completed').length,
    total: item.steps.length,
    current: item.steps.findIndex((step) => step.status === 'inProgress'),
  }
}

/** 进度条 */
export function TodoBar({ done, total }: { done: number; total: number }) {
  const t = useT()
  return (
    <span
      className="todo-bar"
      role="progressbar"
      aria-label={t('todo.title')}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
    >
      <i style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }} />
    </span>
  )
}

/** 说明和一步一行的清单 */
export function TodoSteps({ item }: { item: TodoItem }) {
  const t = useT()
  return (
    <>
      {item.note ? <div className="todo-note">{item.note}</div> : null}
      <ol className="todo-list">
        {item.steps.map((step, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: 步骤没有标识，整份换掉时按位置对
            key={index}
            className={`todo-step ${step.status}`}
            aria-current={step.status === 'inProgress' ? 'step' : undefined}
          >
            <i
              className={step.status === 'inProgress' ? 'todo-mark st run' : 'todo-mark'}
              role="img"
              aria-label={t(STATUS[step.status])}
            />
            <span className="todo-text">{step.text}</span>
          </li>
        ))}
      </ol>
    </>
  )
}

export const TodoCard = memo(function TodoCard(ref: ItemRef) {
  const item = useItem<TodoItem>(ref)
  const t = useT()
  if (item?.kind !== 'todo') return null
  const { done, total, current } = todoProgress(item)
  return (
    // 整张卡片是一行标记：里面的步骤不单独带，带标记的行不能互相套着
    <div className="todo" data-anchor={`d:${ref.itemId}`}>
      <div className="todo-head">
        <span className="todo-title">{t('todo.title')}</span>
        <span className="todo-count">{t('todo.count', { done, total })}</span>
        {current < 0 ? null : (
          <span className="todo-now">{t('todo.now', { index: current + 1 })}</span>
        )}
        <TodoBar done={done} total={total} />
      </div>
      <TodoSteps item={item} />
    </div>
  )
})
