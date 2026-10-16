import { cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { PathWatch } from './path-watch.mjs'
import { ProtocolError, requiredString } from './protocol-contract.mjs'
import type { RpcPeer } from './types.mjs'

function pathParam(params: Record<string, unknown>, key = 'path'): string {
  const value = requiredString(params[key], key)
  if (!isAbsolute(value) || value.includes('\0'))
    throw new ProtocolError(-32602, `${key} 必须是绝对路径`)
  return value
}

export function decodeBase64(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
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

  async call(peer: RpcPeer, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'fs/readFile':
        return { dataBase64: (await readFile(pathParam(params))).toString('base64') }
      case 'fs/readDirectory': {
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
        const path = pathParam(params)
        const [metadata, link] = await Promise.all([stat(path), lstat(path)])
        return {
          isDirectory: metadata.isDirectory(),
          isFile: metadata.isFile(),
          isSymlink: link.isSymbolicLink(),
          createdAtMs: Math.trunc(metadata.birthtimeMs),
          modifiedAtMs: Math.trunc(metadata.mtimeMs),
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
    for (const watcher of this.watchers.get(peerId)?.values() ?? []) watcher.close()
    this.watchers.delete(peerId)
  }

  close(): void {
    for (const peerId of this.watchers.keys()) this.closePeer(peerId)
  }
}
