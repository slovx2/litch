import type { RefBook } from './ax.mjs'
import type { BrowserPage } from './model.mjs'

interface Node {
  backendNodeId: number
  nodeName?: string
  attributes?: string[]
  children?: Node[]
  shadowRoots?: Node[]
  contentDocument?: Node
}

/** AX 不显示隐藏文件框；补充 DOM 中的文件框，不改样式、不读取路径或文件内容。 */
export async function fileInputSnapshot(page: BrowserPage, book: RefBook, lines: string[]) {
  const { root } = await page.cdp<{ root?: Node }>('DOM.getDocument', { depth: -1, pierce: true })
  const visit = async (node: Node): Promise<void> => {
    const attrs = new Map<string, string>()
    for (let i = 0; i < (node.attributes?.length ?? 0); i += 2)
      attrs.set(node.attributes?.[i]?.toLowerCase() ?? '', node.attributes?.[i + 1] ?? '')
    if (node.nodeName === 'INPUT' && attrs.get('type')?.toLowerCase() === 'file') {
      let ref = book.byNode.get(node.backendNodeId)
      if (!ref || !lines.some((line) => line.includes(`[ref=${ref}]`))) {
        const { object } = await page.cdp<{ object: { objectId?: string } }>('DOM.resolveNode', {
          backendNodeId: node.backendNodeId,
        })
        if (object.objectId) {
          try {
            const { result } = await page.cdp<{
              result: { value?: { hidden: boolean; name: string } }
            }>('Runtime.callFunctionOn', {
              objectId: object.objectId,
              functionDeclaration: `function() { return {
                hidden: !this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) || !this.getBoundingClientRect().height,
                name: this.getAttribute('aria-label') || Array.from(this.labels || []).map(l=>l.textContent.trim()).join(' ') || this.name || this.id || 'File'
              } }`,
              returnByValue: true,
            })
            if (!ref) {
              ref = `e${book.generation}g${book.next++}`
              book.byNode.set(node.backendNodeId, ref)
              book.byRef.set(ref, node.backendNodeId)
            }
            lines.push(
              `- file input ${JSON.stringify((result.value?.name ?? 'File').slice(0, 160))}${result.value?.hidden ? ' hidden' : ''}${attrs.has('multiple') ? ' multiple' : ''}${attrs.has('disabled') ? ' disabled' : ''}${attrs.has('accept') ? ` accept=${JSON.stringify(attrs.get('accept'))}` : ''} [ref=${ref}]`,
            )
          } finally {
            await page.cdp('Runtime.releaseObject', { objectId: object.objectId })
          }
        }
      }
    }
    for (const child of [
      ...(node.children ?? []),
      ...(node.shadowRoots ?? []),
      ...(node.contentDocument ? [node.contentDocument] : []),
    ])
      await visit(child)
  }
  if (root) await visit(root)
}
