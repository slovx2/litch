// 目录写法可在客户端预检；home 的值与目录状态只能由目标设备决定。
export type DirectoryValidationReason =
  | 'absolutePath'
  | 'missingDirectory'
  | 'notDirectory'
  | 'unreadableDirectory'
export const homeDirectoryPath = (value: string): boolean => value === '~' || value.startsWith('~/')
export const absoluteDirectoryPath = (value: string): boolean =>
  /^(?:\/|\\|[a-zA-Z]:[\\/])/.test(value)
export const deviceDirectoryPath = (value: string): boolean =>
  homeDirectoryPath(value) || absoluteDirectoryPath(value)
