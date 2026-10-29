import { useEffect, useRef, useState } from 'react'
import { useT } from '../../../app/appearance.ts'
import type { PreviewRendererProps } from '../contract.ts'
import { errorKind, type OfficeError, type Part } from '../office/archive.ts'
import frameUrl from '../office/docx-frame.ts?worker&url'
import { frameResult } from '../office/frame-result.ts'
import { officeJob } from '../office/job.ts'
import '../office/office.css'

export default function DocxPreview({ data }: PreviewRendererProps) {
  const t = useT(),
    frame = useRef<HTMLIFrameElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | OfficeError>('loading')
  useEffect(() => {
    const abort = new AbortController()
    const channel = new MessageChannel()
    let timer: ReturnType<typeof setTimeout> | undefined
    const element = frame.current
    if (!element) return
    let loaded: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      loaded = resolve
      element.addEventListener('load', loaded, { once: true })
    })
    setState('loading')
    const script = new URL(frameUrl, location.href).href
    // 不设 allow-same-origin；只有这个构建脚本可执行。文档脚本、网络、表单、导航均禁用。
    // 纸张白底、文字颜色沿用文档库的版式，应用的深色皮肤不改文档本身的颜色；
    // 纸张外的画布透明，由外层按皮肤铺底。color-scheme 跟随父元素，否则深色下 Chromium 会给 iframe 垫白底。
    element.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${script}; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>:root{color-scheme:light dark}html,body{margin:0;background:transparent}body{overflow:auto}.docx-wrapper{padding:16px!important;background:transparent!important}section.docx{margin:0 auto 16px!important}</style><script src="${script}"></script></head><body></body></html>`
    const fail = (reason: OfficeError) => {
      if (abort.signal.aborted) return
      setState(reason)
      frame.current?.setAttribute('srcdoc', '')
      channel.port1.close()
      clearTimeout(timer)
      abort.abort()
    }
    timer = setTimeout(() => fail('timeout'), 15_000)
    Promise.all([officeJob<Part[]>(data, 'docx', abort.signal), ready]).then(
      ([parts]) => {
        if (abort.signal.aborted) return
        let sent = false
        const send = () => {
          if (sent || abort.signal.aborted) return
          sent = true
          element.contentWindow?.postMessage('litch-office', '*', [channel.port2])
        }
        channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
          if (abort.signal.aborted) return
          const result = frameResult(data)
          if (result === 'ready')
            channel.port1.postMessage(
              parts,
              parts.map((part) => part.bytes.buffer),
            )
          else if (result.ok) {
            clearTimeout(timer)
            setState('ready')
            channel.port1.close()
          } else fail(result.error)
        }
        channel.port1.start()
        // iframe 的 load 可能早于 Worker；已加载的 frame 可立即接收。
        send()
      },
      (error) => {
        if (!abort.signal.aborted) fail(errorKind(error))
      },
    )
    return () => {
      abort.abort()
      clearTimeout(timer)
      channel.port1.close()
      channel.port2.close()
      element.removeEventListener('load', loaded)
      element.srcdoc = ''
    }
  }, [data])
  const failed = state !== 'ready' && state !== 'loading'
  return (
    <div className="office-preview" data-office="docx" data-state={state}>
      {failed ? null : <p className="office-note">{t('preview.docx.note')}</p>}
      {state === 'loading' ? (
        <div className="fv-hold" role="status">
          {t('files.view.loading')}
        </div>
      ) : null}
      {failed ? (
        <div className="fv-hold" data-hold={state} role="status">
          <b>{t(state === 'budget' ? 'files.view.tooLarge' : 'files.view.failed')}</b>
          <span>{t(`preview.docx.${state}`)}</span>
        </div>
      ) : null}
      <iframe
        ref={frame}
        className="office-docx"
        title={t('preview.docx.title')}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        hidden={state !== 'ready'}
      />
    </div>
  )
}
