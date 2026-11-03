// 客户端用户主动选择路径的设备接口，不注册为模型工具，不返回文件内容。
export const PATH_PICKER_METHOD = 'litch/paths/list'
export const PATH_PICKER_EXTENSION = 'devicePaths'
export interface PathPickerEntry {
  name: string
  kind: 'dir' | 'file' | 'link' | 'other'
  targetKind: 'dir' | 'file' | null
  executable: boolean | null
}
export interface PathPickerListing {
  path: string
  parent: string | null
  entries: PathPickerEntry[]
  total: number
  truncated: boolean
}
export interface PathPickerRequests {
  'litch/paths/list': { params: { path: string | null }; result: PathPickerListing }
}
