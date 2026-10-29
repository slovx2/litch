import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net } from 'electron'
import { uiResourcePolicy } from './ui-security.mjs'

/** 与正式主进程和隔离验收共用；不许从 app:// 读取 UI 构建目录之外的文件。 */
export async function serveUiResource(uiRoot: string, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = decodeURIComponent(url.pathname)
  const headers = { 'Content-Security-Policy': uiResourcePolicy(path) }
  if (url.host !== 'ui') return new Response('not found', { status: 404, headers })
  const file = normalize(join(uiRoot, path === '/' ? 'index.html' : path))
  if (!file.startsWith(uiRoot + sep)) return new Response('forbidden', { status: 403, headers })
  const response = await net.fetch(pathToFileURL(file).toString())
  const allHeaders = new Headers(response.headers)
  allHeaders.set('Content-Security-Policy', headers['Content-Security-Policy'])
  return new Response(response.body, { status: response.status, headers: allHeaders })
}
