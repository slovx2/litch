import type { FilePreview, PreviewKind } from '@litch/core'
import type { ComponentType } from 'react'
import type { PreviewResources } from './resources.ts'

export interface PreviewScope {
  deviceId: string
  root: string
  path: string
}
export type PreviewData = Extract<FilePreview, { kind: 'ready' }>
export interface PreviewRendererProps {
  scope: PreviewScope
  data: PreviewData
  resources: PreviewResources
  /** 用户点击本地链接，由公共面板打开；renderer 不自行导航。 */
  open(path: string, line?: number, fragment?: string): void
  /** 当前文档的标题锚点，不是 URL。 */
  fragment?: string | undefined
  /** 同一标题被再次点击也必须定位。 */
  jump?: number | undefined
}
export interface PreviewModule {
  default: ComponentType<PreviewRendererProps>
}
export type PreviewLoader = () => Promise<PreviewModule>
export type PreviewFormat = PreviewKind
