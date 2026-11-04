// 只收固定形状的数据，不让渲染进程指定文件路径。同步完成后才告诉输入框已保存。
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DRAFT_IMAGE_LIMIT,
  type DraftImageEntries,
} from '../../../packages/core/src/draft-images.mjs'

export function draftImageFile(dataDir: string) {
  const path = join(dataDir, 'draft-images.json')
  return {
    read(): unknown {
      try {
        if (statSync(path).size > DRAFT_IMAGE_LIMIT) return null
        return JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        return null
      }
    },
    write(entries: DraftImageEntries): void {
      const data = JSON.stringify(entries)
      if (!Array.isArray(entries) || Buffer.byteLength(data) > DRAFT_IMAGE_LIMIT)
        throw new Error('Draft image storage limit exceeded')
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(`${path}.tmp`, data, { mode: 0o600 })
      renameSync(`${path}.tmp`, path)
    },
    remove(): void {
      rmSync(path, { force: true })
      rmSync(`${path}.tmp`, { force: true })
    },
  }
}
