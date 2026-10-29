import { decodeBase64, previewKind } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../../../app/appearance.ts'
import type { PreviewRendererProps } from '../contract.ts'
import { imageInfo, svgInfo } from '../image-info.ts'
import { documentTarget } from '../paths.ts'
import { htmlDocument, sanitizeHtml } from '../web/html.ts'
import '../web.css'

export default function HtmlPreview({ data, scope, resources }: PreviewRendererProps) {
  const t = useT()
  const [html, setHtml] = useState('')
  const [error, setError] = useState(false)
  const [blocked, setBlocked] = useState(0)
  useEffect(() => {
    let alive = true
    setHtml('')
    setError(false)
    setBlocked(0)
    void (async () => {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(data.dataBase64))
      const clean = sanitizeHtml(source)
      let missed = 0
      // 只处理前 16 个附图，顺序读取避免为超限资源创建无界 Promise 队列。
      for (const [index, { element, href }] of clean.images.entries()) {
        const target = documentTarget(scope.root, scope.path, href)
        const format = target.kind === 'local' ? previewKind(target.path) : null
        let shown = false
        if (index < 16 && target.kind === 'local' && (format === 'image' || format === 'svg')) {
          try {
            const result = await resources.load({ ...scope, path: target.path }, format, true)
            if (!alive || resources.abort.signal.aborted) return
            if (result.kind === 'ready') {
              const bytes = decodeBase64(result.dataBase64)
              const info =
                format === 'svg' ? svgInfo(new TextDecoder().decode(bytes)) : imageInfo(bytes)
              if (info && resources.claimPixels(target.path, info.width * info.height)) {
                // app:// 的 Blob URL 不能被不透明来源的 srcdoc 读取；仅内嵌已核验的设备图片。
                element.src = `data:${info.mime};base64,${result.dataBase64}`
                shown = true
              }
            }
          } catch {
            /* 资源失败不使整篇文档失败。 */
          }
        }
        if (!alive || resources.abort.signal.aborted) return
        if (!shown) {
          missed++
          element.replaceWith(
            document.createTextNode(`[${element.alt || t('preview.html.imageBlocked')}]`),
          )
        }
      }
      if (alive) {
        setBlocked(missed)
        setHtml(htmlDocument(clean.fragment))
      }
    })().catch(() => {
      if (alive) setError(true)
    })
    return () => {
      alive = false
    }
  }, [data, scope, resources, t])
  if (error)
    return (
      <div className="fv-hold" role="status">
        <span>{t('preview.html.invalid')}</span>
      </div>
    )
  return (
    <div className="fp-web fp-html">
      <div className="fp-web-note" role="status">
        {t('preview.html.static')}
        {blocked ? <span>{t('preview.html.blocked', { count: blocked })}</span> : null}
      </div>
      {html ? (
        <iframe
          title={t('preview.html.title')}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={html}
          className="fp-html-frame"
        />
      ) : (
        <div className="fv-hold">{t('files.view.loading')}</div>
      )}
    </div>
  )
}
