/** 用户浏览目录的设备端预算；不改变标准 fs/readDirectory 的默认行为。 */
export const FILE_BROWSER_ENTRIES = 2000
export interface FileDirectoryBudget {
  maxEntries: number
}
export interface FileDirectoryResult {
  /** 只表示后面还有条目，不为计数继续扫描目录。 */
  truncated: boolean
}
