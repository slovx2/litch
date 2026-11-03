/** 设备与 Claude/Pi 之间的内部协调，不转发给客户端。 */
export const RESUME_TOOLS_READ = 'litch/internal/thread/tools/read'
export const RESUME_TOOLS_CHANGED = 'litch/internal/thread/tools/changed'

export interface ResumeToolsSnapshot {
  dynamicTools: unknown[]
  restricted: boolean
  instance: string
  revision: number
}
