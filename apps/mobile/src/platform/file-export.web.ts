import type { CoreChannel } from '@litch/core'
import type { ExportProgress, ExportSource } from './file-export.ts'

export type { ExportProgress, ExportSource } from './file-export.ts'

/** 网页预览不伪装手机系统导出；原生包使用同名原生实现。 */
export async function savePhoneFile(
  _channel: Pick<CoreChannel, 'command'>,
  _source: ExportSource,
  _signal: AbortSignal,
  _progress: (value: ExportProgress) => void,
): Promise<void> {
  throw new Error('exportUnavailable')
}
