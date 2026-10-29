import type {
  AutomationFrameGeometry,
  AutomationPointerSample,
  AutomationSurface,
} from '../../../protocol/src/automation-surface.mjs'

export interface AutomationPreviewOwner {
  deviceId: string
  sessionId: string
}
export interface AutomationPreviewFrame extends AutomationFrameGeometry {
  streamId: string
  seq: number
  data: string
  mime: 'image/jpeg'
  receivedAt: number
}
export interface AutomationPreviewView {
  owner: AutomationPreviewOwner
  app: string
  surface: AutomationSurface | null
  pointer: AutomationPointerSample | null
  frame: AutomationPreviewFrame | null
  status: string
  foreground: boolean
  pinned: boolean
  updatedAt: number
}
export interface AutomationPreviewCommand extends AutomationPreviewOwner {
  action: 'show' | 'hide' | 'stop' | 'takeover' | 'ack' | 'pin' | 'unpin'
  streamId?: string
  seq?: number
}
export interface AutomationPreviewPort {
  command(command: AutomationPreviewCommand): Promise<void>
  listen(handler: (view: AutomationPreviewView | null, owner: AutomationPreviewOwner) => void): void
}
export const previewOwnerKey = (owner: AutomationPreviewOwner): string =>
  JSON.stringify([owner.deviceId, owner.sessionId])
