// 输入框上面弹出来的那张单子：打 `/` 列命令和技能，打 `@` 找文件和目录。
// 焦点一直留在输入框里，单子自己不拿焦点：上下键、回车、Tab、Esc 由输入框的按键处理转过来（useSuggestKeys），
// 别的键照常是打字，打的字就是过滤的词。这样单子开着的时候按键不会落到别处（比如输入框上面的请求卡片）。
// 行上只放一眼要看的：记号、名字、一句说明；选中那一项的全文和来源、位置在单子底下那一栏。
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Icon, Slash, Spark } from '../app/icons.tsx'
import { type Rankable, step } from './suggest.ts'

export interface SuggestEntry extends Rankable {
  id: string
  /** 记号按它画：命令、技能、文件、目录；again 是“再试一次”那一行 */
  kind: 'command' | 'skill' | 'again' | 'file' | 'dir'
  title: string
  /** 一句说明，行上放不下就截断，全文在底下那一栏 */
  note: string
  /** 底下那一栏另外列的几样：来源、位置。行上不放 */
  facts?: { label: string; value: string }[]
}

export interface SuggestGroup {
  id: string
  title: string
  entries: SuggestEntry[]
  /** 这一组现在的状况：正在取、没取到、对面没有。排在条目后面；err 用出错的颜色；detail 是鼠标停上去才看的全文 */
  status?: { text: string; tone?: 'plain' | 'err'; detail?: string }
}

const ICONS: Record<SuggestEntry['kind'], () => ReactNode> = {
  command: Slash,
  skill: Spark,
  again: Spark,
  file: () => <Icon name="file" />,
  dir: () => <Icon name="folder" />,
}

interface SuggestProps {
  label: string
  groups: SuggestGroup[]
  /** 选中的是哪一项 */
  active: string | null
  /** 一项都没有、各组也没有要交代的状况时说的那一句 */
  empty: string
  onActive(id: string): void
  onPick(entry: SuggestEntry): void
}

export function Suggest({ label, groups, active, empty, onActive, onPick }: SuggestProps) {
  const list = useRef<HTMLDivElement>(null)
  const shown = groups.filter((group) => group.entries.length > 0 || group.status)
  const current = shown.flatMap((group) => group.entries).find((entry) => entry.id === active)

  // 选中的那一项滚进看得见的地方（键盘往下走过了单子的底）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 选中的换了才滚
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    // 鼠标点在单子上不能把输入框的焦点带走：按下的那一下拦掉，点击照常
    // biome-ignore lint/a11y/noStaticElementInteractions: 只是不让焦点离开输入框，键盘操作在输入框里
    <div className="sug" data-count={shown.length} onMouseDown={(event) => event.preventDefault()}>
      <div className="sug-list" role="listbox" aria-label={label} ref={list}>
        {shown.length === 0 ? <div className="sug-note">{empty}</div> : null}
        {shown.map((group) => (
          // biome-ignore lint/a11y/useSemanticElements: 分组在单子里，用 fieldset 会带上表单的语义
          <div key={group.id} role="group" aria-label={group.title} data-group={group.id}>
            <div className="sug-head">{group.title}</div>
            {group.entries.map((entry) => {
              const Mark = ICONS[entry.kind]
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="option"
                  // 焦点留在输入框里：这些按钮不进 Tab 的顺序
                  tabIndex={-1}
                  className="sug-opt"
                  aria-selected={entry.id === active}
                  data-entry={entry.id}
                  data-kind={entry.kind}
                  onPointerMove={() => entry.id !== active && onActive(entry.id)}
                  onClick={() => onPick(entry)}
                >
                  <Mark />
                  <b>{entry.title}</b>
                  <span className="ell">{entry.note}</span>
                </button>
              )
            })}
            {group.status ? (
              <div
                className={group.status.tone === 'err' ? 'sug-note err' : 'sug-note'}
                role="status"
                title={group.status.detail}
              >
                {group.status.text}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {current ? (
        <div className="sug-foot" data-for={current.id}>
          <span className="sug-foot-note">{current.note}</span>
          {current.facts?.map((fact) => (
            <span key={fact.label} className="sug-fact">
              <i>{fact.label}</i>
              <span className="ell">{fact.value}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 单子的按键和“选中的是哪一项”。entries 是单子里从上到下的全部条目；open 为假时什么都不管。
 * onKeyDown 返回真表示这个键归单子、已经处理了，输入框不要再当成自己的（发送、翻输入历史）。
 */
export function useSuggestKeys(
  open: boolean,
  entries: readonly SuggestEntry[],
  onPick: (entry: SuggestEntry) => void,
  onClose: () => void,
) {
  const [wanted, setActive] = useState<string | null>(null)
  // 过滤之后原来选的那一项不在了，就落到第一项上
  const at = entries.findIndex((entry) => entry.id === wanted)
  const active = entries[at < 0 ? 0 : at]?.id ?? null
  // 单子收起来之后，下次打开从第一项开始
  useEffect(() => {
    if (!open) setActive(null)
  }, [open])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false
    // 输入法还在选词：这些键是给候选框的
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    const taken = () => {
      // 这个键到此为止：不发送，也不再往外冒（外面有听回车和 Esc 的）
      event.preventDefault()
      event.stopPropagation()
      return true
    }
    if (event.key === 'Escape') {
      onClose()
      return taken()
    }
    // 单子里没有能选的（正在取、没有叫这个的）：别的键照常归输入框，回车照常发送
    if (entries.length === 0) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = step(entries.length, Math.max(at, 0), event.key === 'ArrowDown' ? 1 : -1)
      setActive(entries[next]?.id ?? null)
      return taken()
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      const entry = entries[Math.max(at, 0)]
      if (entry) onPick(entry)
      return taken()
    }
    return false
  }

  return { active, setActive, onKeyDown }
}
