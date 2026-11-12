// 文件链接的技术详情：链接原文、解析出的路径、试过的路径和失败原因。
// 链接失败的对话框里折叠显示（FileLinkDetails）；文件查看器里收进标题栏的 info 图标浮层（FileLinkInfo）。
import type { FileLinkResolution } from '@litch/core'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { runFileAction } from './actions.ts'

/** 浮层和图标之间、浮层和窗口边沿之间留的空 */
const GAP = 4
const EDGE = 8

export function FileLinkDetails({
  result,
  expanded = false,
  copy = true,
}: {
  result: FileLinkResolution
  expanded?: boolean
  copy?: boolean
}) {
  const t = useT()
  return (
    <details className="file-link-details" open={expanded || undefined}>
      <summary>{t('files.link.details')}</summary>
      <FileLinkFacts result={result} copy={copy} />
    </details>
  )
}

/** 文件标题栏里的 info 图标：点开浮出技术详情，点外面或按 Esc 收起 */
export function FileLinkInfo({ result }: { result: FileLinkResolution }) {
  const t = useT()
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // 默认在图标下方、右端对齐；下方放不下就放到上方，左右不出窗口
  useLayoutEffect(() => {
    const panel = box.current
    const anchor = button.current
    if (!open || !panel || !anchor) return
    const at = anchor.getBoundingClientRect()
    const below = at.bottom + GAP
    const top =
      below + panel.offsetHeight > window.innerHeight - EDGE
        ? at.top - GAP - panel.offsetHeight
        : below
    const left = Math.min(
      at.right - panel.offsetWidth,
      window.innerWidth - EDGE - panel.offsetWidth,
    )
    panel.style.left = `${Math.max(EDGE, left)}px`
    panel.style.top = `${Math.max(EDGE, top)}px`
  }, [open])
  return (
    <>
      <button
        ref={button}
        type="button"
        className="ibtn"
        data-tool="link-info"
        title={t('files.link.details')}
        aria-label={t('files.link.details')}
        aria-expanded={open}
        popoverTarget={id}
      >
        <Icon name="info" small />
      </button>
      <div
        ref={box}
        id={id}
        className="file-link-pop"
        popover="auto"
        role="dialog"
        aria-label={t('files.link.details')}
        onToggle={(event) => setOpen(event.newState === 'open')}
      >
        <FileLinkFacts result={result} copy />
      </div>
    </>
  )
}

function FileLinkFacts({ result, copy }: { result: FileLinkResolution; copy: boolean }) {
  const t = useT()
  // 失败原因并到对应的尝试路径后面，不另列一遍同样的路径
  const reasons = new Map(result.failures.map((failure) => [failure.path, failure.reason]))
  const tried = [
    ...result.attempted,
    ...result.failures
      .map((failure) => failure.path)
      .filter((path) => !result.attempted.includes(path)),
  ]
  return (
    <>
      <dl>
        <dt>{t('files.link.href')}</dt>
        <dd>{result.href}</dd>
        <dt>{t('files.link.path')}</dt>
        <dd>{result.path || t('files.link.notResolved')}</dd>
        <dt>{t('files.link.attempted')}</dt>
        <dd>
          {tried.length
            ? tried.map((path) => {
                const reason = reasons.get(path)
                return (
                  <div key={path}>
                    {path}
                    {reason ? (
                      <span className="file-link-reason">
                        {' · '}
                        {t(`files.link.error.${reason}`)}
                      </span>
                    ) : null}
                  </div>
                )
              })
            : t('files.link.notAttempted')}
        </dd>
      </dl>
      {copy ? (
        <button
          type="button"
          className="btn"
          onClick={() =>
            runFileAction('copyFull', { path: result.path || result.href, relative: '' })
          }
        >
          {t('files.action.copyFull')}
        </button>
      ) : null}
    </>
  )
}
