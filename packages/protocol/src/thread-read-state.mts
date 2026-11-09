/** 设备完成序号只在当前设备库内有序，不能用客户端时间替代。 */
export interface ThreadReadState {
  threadId: string
  turnId: string | null
  completedSequence: number
  readSequence: number
}

export const THREAD_READ_STATE = {
  list: 'litch/thread/readState/list',
  mark: 'litch/thread/readState/mark',
  changed: 'litch/thread/readState/changed',
} as const

export const THREAD_READ_BATCH = 500
