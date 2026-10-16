// 提问的向导：一次请求里有几道题就一道一道地问，可以来回翻、可以跳过，答到一半的内容记着。
// 键位：数字键选选项（排在最后的数字是“其他”），上下键在选项间移动，左右键翻题，回车前进（最后一题是交卷）。
// 选了一个选项之后隔一小会儿自己前进；在最后一题上选完，每道题又都有了说法，就直接交卷。
import {
  collectAnswers,
  type QuestionEntry,
  type QuestionRequest,
  type QuestionState,
  type QuestionView,
  questionState,
} from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import type { MessageKey } from '../i18n/index.ts'
import { busyWriting, typing } from './focus.ts'
import { loadQuestionDraft, type QuestionDraft, saveQuestionDraft } from './question-drafts.ts'
import { type CardProps, Foot, ownsKey, useRespond } from './respond.tsx'

/** 选了一个选项之后隔这么久自己前进：够看清选中了哪个，又不用再按一下 */
const ADVANCE_MS = 180

/**
 * 卡片被压矮、自己在滚的时候，把一样东西挪到看得见的地方。
 * 底下那排按钮是贴着底的，会挡住一截，要让开它
 */
function reveal(scroller: HTMLElement, item: HTMLElement): void {
  if (scroller.scrollHeight <= scroller.clientHeight) return
  const view = scroller.getBoundingClientRect()
  const box = item.getBoundingClientRect()
  const bar = scroller.querySelector<HTMLElement>('.req-actions')?.offsetHeight ?? 0
  const floor = view.bottom - bar
  if (box.top < view.top) scroller.scrollTop -= view.top - box.top + 8
  else if (box.bottom > floor) scroller.scrollTop += box.bottom - floor + 8
}

const STEP_TEXT: Record<QuestionState, MessageKey> = {
  open: 'request.stepOpen',
  answered: 'request.stepAnswered',
  skipped: 'request.stepSkipped',
}

interface PageProps {
  question: QuestionView
  entry: QuestionEntry | undefined
  busy: boolean
  onPick(label: string): void
  onOther(): void
  onType(text: string): void
  /** 在输入框里按了回车 */
  onEnter(): void
  /** 在输入框里按了上箭头：回到选项里去 */
  onLeave(): void
}

/** 一道题：选项单选，可以另外自己填；没有选项的题只有输入框 */
function QuestionPage(props: PageProps) {
  const { question, entry, busy } = props
  const t = useT()
  const options = question.options ?? []
  const other = entry?.kind === 'other'
  const text = entry?.kind === 'other' ? entry.text : ''
  return (
    <>
      <div className="req-q">{question.question}</div>
      <div className="req-body">
        {options.length > 0 ? (
          <div className="opts" role="radiogroup" aria-label={question.header || question.question}>
            {options.map((option, index) => (
              // biome-ignore lint/a11y/useSemanticElements: 选项里有两行文字，原生单选框排不出来
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: 对面给的标签可能重复，一道题的选项不会增删换位
                key={index}
                type="button"
                role="radio"
                className="opt"
                data-option={index}
                aria-checked={entry?.kind === 'option' && entry.label === option.label}
                disabled={busy}
                onClick={() => props.onPick(option.label)}
              >
                {index < 9 ? <span className="kbd">{index + 1}</span> : null}
                <span className="tx">
                  <b>{option.label}</b>
                  {option.description ? <span>{option.description}</span> : null}
                </span>
              </button>
            ))}
            {question.allowOther ? (
              // biome-ignore lint/a11y/useSemanticElements: 同上
              <button
                type="button"
                role="radio"
                className="opt"
                data-option="other"
                aria-checked={other}
                disabled={busy}
                onClick={props.onOther}
              >
                {options.length < 9 ? <span className="kbd">{options.length + 1}</span> : null}
                <span className="tx">
                  <b>{t('request.other')}</b>
                </span>
              </button>
            ) : null}
          </div>
        ) : null}
        {options.length === 0 || other ? (
          <input
            className="req-input"
            type={question.secret ? 'password' : 'text'}
            value={text}
            placeholder={t('request.otherPlaceholder')}
            aria-label={question.header || question.question}
            disabled={busy}
            onChange={(event) => props.onType(event.target.value)}
            onKeyDown={(event) => {
              // 输入法还在选词：这个回车是确认候选，方向键是在候选里挑
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter') {
                event.preventDefault()
                props.onEnter()
              } else if (event.key === 'ArrowUp' && options.length > 0) {
                event.preventDefault()
                props.onLeave()
              }
            }}
          />
        ) : null}
      </div>
    </>
  )
}

export function QuestionCard(props: CardProps<QuestionRequest>) {
  const { request, waiting, deviceId, sessionId } = props
  const t = useT()
  const { busy, error, respond } = useRespond(props)
  const ref = { deviceId, sessionId, requestId: request.id }
  const [draft, setDraft] = useState<QuestionDraft>(
    () => loadQuestionDraft(ref) ?? { page: 0, entries: {} },
  )
  /** 交卷时发现还没答的那道题排第几。说明留到它有了说法，或者人翻走了为止 */
  const [nagged, setNagged] = useState<number | null>(null)
  const card = useRef<HTMLElement>(null)
  /** 最新的草稿。定时的前进到点时按它算，不按设下定时的那一刻算 */
  const latest = useRef(draft)
  const timer = useRef<number | null>(null)
  const mounted = useRef(false)

  const questions = request.questions
  const count = questions.length
  const clamp = (index: number) => Math.min(Math.max(index, 0), Math.max(count - 1, 0))
  const page = clamp(draft.page)
  const question = questions[page]
  const entry = question ? draft.entries[question.id] : undefined
  const state = questionState(entry)
  const last = page >= count - 1
  const options = question?.options ?? []
  /** 这道题现在有没有输入框：没有选项的题一直有，有选项的题选了“其他”才有 */
  const writing = options.length === 0 || entry?.kind === 'other'

  /** 人又动了一下（换了选项、翻了题、按了键）：还没到点的前进不算数了，以这一下为准 */
  const cancelAuto = () => {
    if (timer.current === null) return
    window.clearTimeout(timer.current)
    timer.current = null
  }
  // 卡片没了（切走会话、请求在别处答了）：到点的前进不能再执行，那会替人把卷交了
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const update = (next: QuestionDraft) => {
    latest.current = next
    saveQuestionDraft(ref, next)
    setDraft(next)
  }
  const goto = (index: number) => {
    cancelAuto()
    setNagged(null)
    update({ ...latest.current, page: clamp(index) })
  }
  const put = (id: string, next: QuestionEntry) =>
    update({ ...latest.current, entries: { ...latest.current.entries, [id]: next } })

  /** 交卷。还有没答的：翻到第一道没答的题上说明一句，不交 */
  const submit = () => {
    cancelAuto()
    if (busy) return
    const result = collectAnswers(questions, latest.current.entries)
    if ('open' in result) {
      update({ ...latest.current, page: result.open })
      setNagged(result.open)
      return
    }
    setNagged(null)
    respond({ answers: result.answers })
  }
  /** 前进：不是最后一题就到下一题，最后一题就是交卷 */
  const forward = () => {
    const at = clamp(latest.current.page)
    if (at < count - 1) goto(at + 1)
    else submit()
  }
  /** 选一个选项。auto：隔一小会儿自己前进（点的、按数字键选的）；用方向键挪过去的不前进 */
  const pick = (label: string, auto: boolean) => {
    if (busy || !question) return
    cancelAuto()
    put(question.id, { kind: 'option', label })
    if (!auto) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      forward()
    }, ADVANCE_MS)
  }
  /** 选“其他”：接着自己填。已经在填的，写了的字不动 */
  const pickOther = () => {
    if (busy || !question) return
    cancelAuto()
    const before = latest.current.entries[question.id]
    put(question.id, { kind: 'other', text: before?.kind === 'other' ? before.text : '' })
  }
  const type = (text: string) => {
    if (busy || !question) return
    cancelAuto()
    put(question.id, { kind: 'other', text })
  }
  /** 这道题不答，往前走 */
  const skip = () => {
    if (busy || !question) return
    cancelAuto()
    put(question.id, { kind: 'skipped' })
    forward()
  }
  /** 上下键：在选项间挪动选中的那个，过了最后一项进“其他” */
  const move = (delta: 1 | -1) => {
    if (!question || options.length === 0) return
    const slots = options.length + (question.allowOther ? 1 : 0)
    const current =
      entry?.kind === 'option'
        ? options.findIndex((option) => option.label === entry.label)
        : entry?.kind === 'other'
          ? options.length
          : -1
    const next =
      current < 0
        ? delta > 0
          ? 0
          : options.length - 1
        : Math.min(Math.max(current + delta, 0), slots - 1)
    const option = options[next]
    if (option) pick(option.label, false)
    else pickOther()
  }

  // 卡片一出现就拿焦点；翻到要打字的题、选了“其他”，焦点进输入框。
  // 人正在别处写着东西的不打断（会话的输入框空着不算在写，见 busyWriting）
  const questionId = question?.id
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换了题、输入框出现或消失的时候才重新安排焦点
  useEffect(() => {
    const first = !mounted.current
    mounted.current = true
    const node = card.current
    if (!node) return
    const active = document.activeElement
    const inside = node.contains(active)
    if (busyWriting(active) && !inside) return
    // 焦点在卡片外别的东西上（侧栏的某一行）：那是人放过去的，自己前进的时候不抢
    if (!first && !inside && active !== document.body) return
    const field = node.querySelector<HTMLInputElement>('input.req-input')
    if (field) field.focus({ preventScroll: true })
    // 原来拿着焦点的那个选项随着翻题没了：焦点落回卡片上，键盘接着能用
    else if (first || !inside || active === document.body) node.focus({ preventScroll: true })
  }, [questionId, writing])

  // 卡片自己在滚的时候（窗口矮、选项多）：换了题从头看起；用键盘挪到的选项、刚出现的输入框、
  // “还有没答的”那句说明，都挪到看得见的地方
  const shownId = useRef(questionId)
  const chosen = entry?.kind === 'option' ? entry.label : (entry?.kind ?? null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 选的换了、说明出现了才重新看一遍
  useEffect(() => {
    const node = card.current
    if (!node) return
    if (shownId.current !== questionId) {
      shownId.current = questionId
      node.scrollTop = 0
    }
    const item =
      node.querySelector<HTMLElement>('.req-hint.err') ??
      node.querySelector<HTMLElement>('input.req-input') ??
      node.querySelector<HTMLElement>('.opt[aria-checked="true"]')
    if (item) reveal(node, item)
  }, [questionId, chosen, nagged])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (busy || !question || !ownsKey(event, card.current)) return
      // 输入框里的键归输入框：回车和上箭头它自己处理，左右键是在字里挪光标
      if (typing(event.target)) return
      const { key, target } = event
      if (key === 'Enter') {
        if (target instanceof HTMLButtonElement) {
          const slot = target.getAttribute('role') === 'radio' ? target.dataset.option : undefined
          // 焦点在别的按钮上：回车按的是那个按钮
          if (slot === undefined) return
          event.preventDefault()
          // 焦点在某个选项上：回车就是选它并前进；在“其他”上是去填
          if (slot === 'other') return pickOther()
          const focused = options[Number(slot)]
          if (focused) pick(focused.label, false)
        } else event.preventDefault()
        forward()
        return
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        if (count < 2) return
        event.preventDefault()
        goto(clamp(latest.current.page) + (key === 'ArrowLeft' ? -1 : 1))
        return
      }
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        if (options.length === 0) return
        event.preventDefault()
        move(key === 'ArrowUp' ? -1 : 1)
        return
      }
      // 数字键选选项，排在最后的数字是“其他”
      const index = Number(key) - 1
      const option = /^[1-9]$/.test(key) ? options[index] : undefined
      if (option) pick(option.label, true)
      else if (question.allowOther && options.length > 0 && index === options.length) pickOther()
      else return
      event.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (!question) return null
  const multi = count > 1
  return (
    <section className="req" ref={card} tabIndex={-1} aria-label={t('request.question')}>
      <div className="req-head">
        <i className="st wait" />
        <span>{question.header || t('request.question')}</span>
        <span className="grow" />
        {multi ? <span>{t('request.step', { index: page + 1, count })}</span> : null}
      </div>
      {multi ? (
        // biome-ignore lint/a11y/useSemanticElements: 一排小按钮，不是表单里的一组栏目
        <div className="req-steps" role="group" aria-label={t('request.steps')}>
          {questions.map((each, index) => {
            const mark = questionState(draft.entries[each.id])
            const label = t(STEP_TEXT[mark], { index: index + 1 })
            return (
              <button
                key={each.id}
                type="button"
                className="step"
                data-state={mark}
                aria-current={index === page ? 'step' : undefined}
                aria-label={label}
                title={label}
                disabled={busy}
                onClick={() => goto(index)}
              >
                {index + 1}
              </button>
            )
          })}
        </div>
      ) : null}
      <QuestionPage
        key={question.id}
        question={question}
        entry={entry}
        busy={busy}
        onPick={(label) => pick(label, true)}
        onOther={pickOther}
        onType={type}
        onEnter={forward}
        onLeave={() => move(-1)}
      />
      {state === 'skipped' ? <div className="req-hint">{t('request.skippedNote')}</div> : null}
      {nagged === page && state === 'open' ? (
        <div className="req-hint err" role="status">
          {multi ? t('request.unanswered', { index: page + 1 }) : t('request.unansweredOne')}
        </div>
      ) : null}
      <div className="req-actions">
        {multi ? (
          <>
            <button
              type="button"
              className="btn ghost"
              data-act="back"
              disabled={busy || page === 0}
              onClick={() => goto(page - 1)}
            >
              <span className="kbd">←</span>
              {t('request.back')}
            </button>
            <button
              type="button"
              className="btn ghost"
              data-act="next"
              disabled={busy || last}
              onClick={() => goto(page + 1)}
            >
              {t('request.next')}
              <span className="kbd">→</span>
            </button>
            <button
              type="button"
              className="btn ghost"
              data-act="skip"
              disabled={busy}
              onClick={skip}
            >
              {t('request.skip')}
            </button>
            <span className="grow" />
          </>
        ) : null}
        <button
          type="button"
          className="btn primary"
          data-act="submit"
          disabled={busy}
          onClick={submit}
        >
          {t('request.submit')}
          {last ? <span className="kbd">↵</span> : null}
        </button>
        {multi ? null : (
          <button
            type="button"
            className="btn ghost"
            data-act="skip"
            disabled={busy}
            onClick={skip}
          >
            {t('request.skip')}
          </button>
        )}
      </div>
      <Foot waiting={waiting} error={error} />
    </section>
  )
}
