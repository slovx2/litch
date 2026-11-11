import { type FileHandle, open } from 'node:fs/promises'
import { basename } from 'node:path'
import { UPLOAD_COMMIT_MARK } from '../../browser/src/browser/input-command.mjs'
import type { BrowserPage } from '../../browser/src/browser/model.mjs'
import { fileMime } from '../../browser/src/browser/upload-target.mjs'

// 一次调用的总量也受此限制；base64 后单包 256 KiB，低于桥的 512 KiB 与原生消息的 1 MiB。
export const CHROME_UPLOAD_MAX_BYTES = 512 * 1024 * 1024
export const UPLOAD_CHUNK_BYTES = 192 * 1024
interface Reply {
  result?: { objectId?: string; value?: unknown }
  exceptionDetails?: { exception?: { description?: string }; text?: string }
}

// 数据只存在独立 world 的远程对象里；页面在最终派发前拿不到 File。
// 被撤租约后清理命令也可能被拒，故另设空闲清理，不让大文件留到关页才回收。
const BEGIN = `function(mode,count) {
  if (!this.isConnected) throw Error('Upload target was removed');
  if (mode === 'input' && (!(this instanceof HTMLInputElement) || this.type !== 'file' || this.disabled || this.webkitdirectory || (!this.multiple && count > 1)))
    throw Error('This file input cannot accept the requested files');
  const state={target:this,parts:[],files:[],size:0,expired:false,timer:0};
  state.clear=()=>{clearTimeout(state.timer);state.parts=[];state.files=[];state.target=null;state.expired=true};
  state.touch=()=>{if(state.expired)throw Error('Upload expired');clearTimeout(state.timer);state.timer=setTimeout(state.clear,30000)};
  state.touch(); return state;
}`
const CHUNK = `function(base64) {
  this.touch(); const raw=atob(base64); const bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  this.parts.push(new Blob([bytes])); this.size+=bytes.length; return this.size;
}`
const FILE = `function(meta) {
  this.touch(); if(this.size!==meta.size)throw Error('Upload byte count mismatch');
  this.files.push(new File(this.parts,meta.name,{type:meta.type,lastModified:meta.lastModified}));
  this.parts=[]; this.size=0;
}`
const COMMIT = `function(mode) {
  ${UPLOAD_COMMIT_MARK}
  this.touch(); const target=this.target;
  if(!target?.isConnected)throw Error('Upload target was removed');
  const transfer=new DataTransfer(); for(const file of this.files)transfer.items.add(file);
  try {
    if(mode==='input') {
      if(target.type!=='file' || target.disabled || target.webkitdirectory || (!target.multiple && transfer.files.length>1))throw Error('File input changed during upload');
      target.files=transfer.files;
      target.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
      target.dispatchEvent(new Event('change',{bubbles:true}));
    } else {
      for(const type of ['dragenter','dragover','drop'])
        target.dispatchEvent(new DragEvent(type,{dataTransfer:transfer,bubbles:true,cancelable:true,composed:true}));
    }
    return {kind:'upload',ok:true};
  } finally {this.clear()}
}`

export async function uploadChromeFiles(
  page: BrowserPage,
  backendNodeId: number,
  paths: string[],
  mode: 'input' | 'drop',
): Promise<void> {
  const handles: FileHandle[] = []
  const objects: string[] = []
  let state: string | undefined
  const invoke = async (
    objectId: string,
    functionDeclaration: string,
    values: unknown[] = [],
    byValue = true,
  ) => {
    const reply = await page.cdp<Reply>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      arguments: values.map((value) => ({ value })),
      returnByValue: byValue,
    })
    if (reply.exceptionDetails)
      throw Error(
        reply.exceptionDetails.exception?.description ??
          reply.exceptionDetails.text ??
          'Chrome upload script failed',
      )
    if (reply.result?.objectId) objects.push(reply.result.objectId)
    return reply.result
  }
  try {
    if (!paths.length || paths.length > 32) throw Error('Upload accepts 1 to 32 files per call')
    const files = []
    let total = 0
    for (const path of paths) {
      const handle = await open(path, 'r')
      handles.push(handle)
      const stat = await handle.stat()
      total += stat.size
      if (!stat.isFile() || total > CHROME_UPLOAD_MAX_BYTES)
        throw Error('Upload requires regular files totaling at most 512 MiB')
      files.push({
        handle,
        stat,
        name: basename(path),
        type: fileMime(path),
      })
    }
    const node = await page.cdp<{ object: { objectId: string } }>('DOM.resolveNode', {
      backendNodeId,
    })
    objects.push(node.object.objectId)
    const doc = await invoke(
      node.object.objectId,
      'function(){return this.ownerDocument}',
      [],
      false,
    )
    const described = await page.cdp<{ node: { backendNodeId: number } }>('DOM.describeNode', {
      objectId: doc?.objectId,
    })
    interface FrameTree {
      frame: { id: string }
      childFrames?: FrameTree[]
    }
    const { frameTree } = await page.cdp<{ frameTree: FrameTree }>('Page.getFrameTree')
    const frames = (tree: FrameTree): string[] => [
      tree.frame.id,
      ...(tree.childFrames ?? []).flatMap(frames),
    ]
    let contextId: number | undefined
    // 用文档的 backendNodeId 匹配目标 frame，不能用 URL（同 URL 的 iframe 可有多个）。
    for (const frameId of frames(frameTree)) {
      const world = await page.cdp<{ executionContextId: number }>('Page.createIsolatedWorld', {
        frameId,
        worldName: 'litch-file-upload',
        grantUniveralAccess: false,
      })
      const document = await page.cdp<Reply>('Runtime.evaluate', {
        expression: 'document',
        contextId: world.executionContextId,
      })
      if (!document.result?.objectId) throw Error('Cannot resolve the upload frame document')
      objects.push(document.result.objectId)
      const candidate = await page.cdp<{ node: { backendNodeId: number } }>('DOM.describeNode', {
        objectId: document.result.objectId,
      })
      if (candidate.node.backendNodeId === described.node.backendNodeId) {
        contextId = world.executionContextId
        break
      }
    }
    if (contextId === undefined) throw Error('Cannot resolve the upload frame')
    const isolated = await page.cdp<{ object: { objectId: string } }>('DOM.resolveNode', {
      backendNodeId,
      executionContextId: contextId,
    })
    objects.push(isolated.object.objectId)
    state = (await invoke(isolated.object.objectId, BEGIN, [mode, paths.length], false))?.objectId
    if (!state) throw Error('Cannot prepare the upload target')
    const bytes = Buffer.allocUnsafe(UPLOAD_CHUNK_BYTES)
    const deadline = Date.now() + 5 * 60_000
    for (const file of files) {
      let offset = 0
      while (offset < file.stat.size) {
        if (Date.now() > deadline) throw Error('Upload exceeded five minutes')
        const { bytesRead } = await file.handle.read(
          bytes,
          0,
          Math.min(bytes.length, file.stat.size - offset),
          offset,
        )
        if (!bytesRead) throw Error('The local file changed during upload')
        const result = await invoke(state, CHUNK, [bytes.subarray(0, bytesRead).toString('base64')])
        offset += bytesRead
        if (result?.value !== offset) throw Error('Chrome did not acknowledge the upload chunk')
      }
      const after = await file.handle.stat()
      if (after.size !== file.stat.size || after.mtimeMs !== file.stat.mtimeMs)
        throw Error('The local file changed during upload')
      await invoke(state, FILE, [
        {
          name: file.name,
          type: file.type,
          size: offset,
          lastModified: Math.trunc(file.stat.mtimeMs),
        },
      ])
    }
    await invoke(state, COMMIT, [mode])
  } catch (error) {
    throw Error(
      `Chrome file upload failed: ${error instanceof Error ? error.message : String(error)}. Inspect the page response before continuing; use a fresh snapshot or renew the existing tab lease as indicated by the error. Do not replay the upload blindly.`,
    )
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.close()))
    if (state) await invoke(state, 'function(){this.clear()}').catch(() => {})
    await Promise.allSettled(
      objects.map((objectId) => page.cdp('Runtime.releaseObject', { objectId })),
    )
  }
}
