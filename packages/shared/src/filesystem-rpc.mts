import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { readDirectoryBounded } from './file-directory.mjs'
import { readFileChunk } from './file-download.mjs'
import { readPreview } from './file-preview.mjs'
import { declaredExtensions } from './harness-declaration.mjs'
import { PathWatch } from './path-watch.mjs'
import { ProtocolError, requiredString } from './protocol-contract.mjs'
import { readShortMedia } from './short-media.mjs'
import type { RpcPeer } from './types.mjs'

function pathParam(params: Record<string, unknown>, key = 'path'): string {
  const value = requiredString(params[key], key)
  if (!isAbsolute(value) || value.includes('\0'))
    throw new ProtocolError(-32602, `${key} 必须是绝对路径`)
  return value
}

export function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new ProtocolError(-32602, 'dataBase64 必须是有效的 base64')
  return Buffer.from(value, 'base64')
}

function optionalBoolean(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (params[key] == null) return fallback
  if (typeof params[key] !== 'boolean') throw new ProtocolError(-32602, `${key} 必须是布尔值`)
  return params[key]
}

export class FilesystemRpc {
  private watchers = new Map<string, Map<string, PathWatch>>()
  private realpathPeers = new Set<string>()
  private shortMediaPeers = new Set<string>()
  private browserPeers = new Set<string>()
  private downloadPeers = new Set<string>()
  private downloads = 0
  private previewPeers = new Set<string>()
  private previews = 0

  declare(peer: RpcPeer, params: unknown): void {
    if (declaredExtensions(params).has('fileRealpath')) this.realpathPeers.add(peer.id)
    else this.realpathPeers.delete(peer.id)
    if (declaredExtensions(params).has('shortMedia')) this.shortMediaPeers.add(peer.id)
    else this.shortMediaPeers.delete(peer.id)
    if (declaredExtensions(params).has('fileBrowser')) this.browserPeers.add(peer.id)
    else this.browserPeers.delete(peer.id)
    if (declaredExtensions(params).has('fileDownload')) this.downloadPeers.add(peer.id)
    else this.downloadPeers.delete(peer.id)
    if (declaredExtensions(params).has('filePreview')) this.previewPeers.add(peer.id)
    else this.previewPeers.delete(peer.id)
  }

  async call(
    peer: RpcPeer,
    method: string,
    params: Record<string, unknown>,
    previewAllowed = this.previewPeers.has(peer.id),
    downloadAllowed = this.downloadPeers.has(peer.id),
    browserAllowed = this.browserPeers.has(peer.id),
    shortMediaAllowed = this.shortMediaPeers.has(peer.id),
    realpathAllowed = this.realpathPeers.has(peer.id),
  ): Promise<unknown> {
    switch (method) {
      case 'fs/readFile': {
        if (params.litchShortMedia !== undefined) {
          if (!shortMediaAllowed) throw new ProtocolError(-32602, 'shortMedia required')
          if (params.litchReadRange !== undefined || params.litchPreview !== undefined)
            throw new ProtocolError(-32602, 'Mixed file read options')
          if (this.previews >= 4)
            throw Object.assign(new ProtocolError(-32004, 'Media reads busy'), {
              data: { litchShortMedia: { kind: 'busy' } },
            })
          this.previews++
          try {
            return await readShortMedia(pathParam(params), params.litchShortMedia)
          } finally {
            this.previews--
          }
        }
        if (params.litchReadRange !== undefined) {
          if (!downloadAllowed) throw new ProtocolError(-32602, 'fileDownload 扩展未声明')
          if (params.litchPreview !== undefined)
            throw new ProtocolError(-32602, '不能混用预览与另存参数')
          if (this.downloads >= 4) throw new ProtocolError(-32004, '分块读取繁忙')
          this.downloads++
          try {
            return await readFileChunk(pathParam(params), params.litchReadRange)
          } finally {
            this.downloads--
          }
        }
        if (params.litchPreview !== undefined) {
          if (!previewAllowed) throw new ProtocolError(-32602, 'filePreview 扩展未声明')
          if (this.previews >= 4)
            throw Object.assign(new ProtocolError(-32004, '预览读取繁忙'), {
              data: { litchPreview: { kind: 'busy' } },
            })
          this.previews++
          try {
            return await readPreview(pathParam(params), params.litchPreview)
          } finally {
            this.previews--
          }
        }
        return { dataBase64: (await readFile(pathParam(params))).toString('base64') }
      }
      case 'fs/readDirectory': {
        if (params.litchDirectory !== undefined) {
          if (!browserAllowed) throw new ProtocolError(-32602, 'fileBrowser 扩展未声明')
          return readDirectoryBounded(pathParam(params), params.litchDirectory)
        }
        const entries = await readdir(pathParam(params), { withFileTypes: true })
        return {
          entries: entries.map((entry) => ({
            fileName: entry.name,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
          })),
        }
      }
      case 'fs/getMetadata': {
        if (params.litchResolve !== undefined && (!realpathAllowed || params.litchResolve !== true))
          throw new ProtocolError(-32602, '真实路径解析需要声明 fileRealpath 且 litchResolve=true')
        const path = pathParam(params)
        const [metadata, link] = await Promise.all([stat(path), lstat(path)])
        return {
          isDirectory: metadata.isDirectory(),
          isFile: metadata.isFile(),
          isSymlink: link.isSymbolicLink(),
          createdAtMs: Math.trunc(metadata.birthtimeMs),
          modifiedAtMs: Math.trunc(metadata.mtimeMs),
          ...(params.litchResolve === true
            ? { litchResolved: { path: await realpath(path) } }
            : {}),
        }
      }
      case 'fs/writeFile':
        await writeFile(pathParam(params), decodeBase64(params.dataBase64))
        return {}
      case 'fs/createDirectory':
        await mkdir(pathParam(params), { recursive: optionalBoolean(params, 'recursive', true) })
        return {}
      case 'fs/remove':
        await rm(pathParam(params), {
          recursive: optionalBoolean(params, 'recursive', true),
          force: optionalBoolean(params, 'force', true),
        })
        return {}
      case 'fs/copy':
        await cp(pathParam(params, 'sourcePath'), pathParam(params, 'destinationPath'), {
          recursive: optionalBoolean(params, 'recursive', false),
        })
        return {}
      case 'fs/watch': {
        const watchId = requiredString(params.watchId, 'watchId')
        const path = pathParam(params)
        const owned = this.watchers.get(peer.id) ?? new Map<string, PathWatch>()
        if (owned.has(watchId)) throw new ProtocolError(-32602, 'watchId 已在此连接使用')
        owned.set(
          watchId,
          new PathWatch(path, (changedPaths) =>
            peer.send({ method: 'fs/changed', params: { watchId, changedPaths } }),
          ),
        )
        this.watchers.set(peer.id, owned)
        return { path }
      }
      case 'fs/unwatch': {
        const watchId = requiredString(params.watchId, 'watchId')
        this.watchers.get(peer.id)?.get(watchId)?.close()
        this.watchers.get(peer.id)?.delete(watchId)
        return {}
      }
      default:
        throw new ProtocolError(-32601, `未知文件方法: ${method}`)
    }
  }

  closePeer(peerId: string): void {
    this.realpathPeers.delete(peerId)
    this.shortMediaPeers.delete(peerId)
    this.browserPeers.delete(peerId)
    this.downloadPeers.delete(peerId)
    this.previewPeers.delete(peerId)
    for (const watcher of this.watchers.get(peerId)?.values() ?? []) watcher.close()
    this.watchers.delete(peerId)
  }

  close(): void {
    this.realpathPeers.clear()
    this.shortMediaPeers.clear()
    this.browserPeers.clear()
    this.downloadPeers.clear()
    this.previewPeers.clear()
    for (const peerId of this.watchers.keys()) this.closePeer(peerId)
  }
}
