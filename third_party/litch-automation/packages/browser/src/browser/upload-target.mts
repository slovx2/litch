import { basename, extname } from 'node:path'
import { BadArgs } from './args.mjs'
import type { BrowserPage } from './model.mjs'

interface DomNode {
  nodeName?: string
  attributes?: string[]
  backendNodeId: number
}

export async function fileInput(page: BrowserPage, backendNodeId: number) {
  const { node } = await page.cdp<{ node: DomNode }>('DOM.describeNode', { backendNodeId })
  const attrs = new Map<string, string>()
  for (let i = 0; i < (node.attributes?.length ?? 0); i += 2)
    attrs.set(node.attributes?.[i]?.toLowerCase() ?? '', node.attributes?.[i + 1] ?? '')
  if (node.nodeName?.toUpperCase() !== 'INPUT' || attrs.get('type')?.toLowerCase() !== 'file')
    return null
  const { object } = await page.cdp<{ object: { objectId?: string } }>('DOM.resolveNode', {
    backendNodeId,
  })
  if (!object.objectId) throw new BadArgs('The file input was removed. Take a fresh snapshot.')
  try {
    const { result } = await page.cdp<{ result: { value?: boolean } }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: "function(){return this.matches(':disabled')}",
      returnByValue: true,
    })
    if (result.value) attrs.set('disabled', '')
  } finally {
    await page.cdp('Runtime.releaseObject', { objectId: object.objectId })
  }
  return attrs
}

export function validateFiles(attrs: Map<string, string>, paths: string[]) {
  if (attrs.has('disabled')) throw new BadArgs('The file input is disabled.')
  if (attrs.has('webkitdirectory')) throw new BadArgs('This input requires a directory, not files.')
  if (paths.length > 1 && !attrs.has('multiple'))
    throw new BadArgs('This file input accepts only one file; provide a single path.')
  const accept = attrs
    .get('accept')
    ?.split(',')
    .map((v) => v.trim().toLowerCase())
    // 无效 token 不构成文件类型限制，例如站点常用的 */*。
    .filter((rule) =>
      /^\.[^,\s]+$|^(audio|image|video)\/\*$|^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(rule),
    )
  if (!accept?.length) return
  for (const path of paths) {
    const name = basename(path).toLowerCase()
    const mime = fileMime(path)
    if (
      !accept.some((rule) =>
        rule.startsWith('.')
          ? name.endsWith(rule)
          : rule.endsWith('/*')
            ? mime.startsWith(rule.slice(0, -1))
            : mime === rule,
      )
    )
      throw new BadArgs(
        `File ${basename(path)} does not match this input's accept=${JSON.stringify(attrs.get('accept'))}.`,
      )
  }
}

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.md': 'text/markdown',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
}
export const fileMime = (path: string) => MIME[extname(path).toLowerCase()] ?? ''

/** 不改 DOM；关联 label 优先，其次 form，最后最近祖先中唯一的文件框。歧义时拒绝。 */
export async function associatedInput(page: BrowserPage, backendNodeId: number) {
  const { object } = await page.cdp<{ object: { objectId?: string } }>('DOM.resolveNode', {
    backendNodeId,
  })
  if (!object.objectId) throw new BadArgs('The upload trigger was removed. Take a fresh snapshot.')
  let found: string | undefined
  try {
    const reply = await page.cdp<{ result: { objectId?: string }; exceptionDetails?: unknown }>(
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration: `function() {
        const file = el => el?.tagName === 'INPUT' && el.type === 'file';
        const label = this.closest('label');
        if (file(label?.control)) return label.control;
        const unique = root => { const inputs=root.querySelectorAll('input[type="file"]');
          if(inputs.length>1) throw Error('Ambiguous upload target: multiple file inputs');
          return inputs[0] || null; };
        const form = this.form || this.closest('form');
        if(form) { const inputs=form.querySelectorAll('input[type="file"]'); if(inputs.length===1) return inputs[0]; }
        for(let parent=this;parent;parent=parent.parentElement) {
          const input=unique(parent); if(input) return input;
        }
        return null;
      }`,
      },
    )
    if (reply.exceptionDetails)
      throw new BadArgs(
        'Ambiguous upload target: multiple file inputs. Use a file input ref from a fresh snapshot.',
      )
    found = reply.result.objectId
    if (!found)
      throw new BadArgs(
        'No file chooser opened and no unique associated file input was found. Take a fresh snapshot and select its file input or upload trigger.',
      )
    return (await page.cdp<{ node: DomNode }>('DOM.describeNode', { objectId: found })).node
      .backendNodeId
  } finally {
    await Promise.allSettled(
      [object.objectId, found]
        .filter((id): id is string => !!id)
        .map((objectId) => page.cdp('Runtime.releaseObject', { objectId })),
    )
  }
}
