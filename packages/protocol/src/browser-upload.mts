/** 仅供已声明此扩展的客户端，按调用所属设备有界读取上传源。 */
export const BROWSER_UPLOAD_EXTENSION = 'litchBrowserUpload'
export const BROWSER_UPLOAD_METHOD = 'litch/browserUpload/read'
export const UPLOAD_CHUNK_BYTES = 192 * 1024
export const UPLOAD_SOURCE_MAX_BYTES = 512 * 1024 * 1024
export type UploadReadParams =
  | { path: string; action: 'stat' }
  | { path: string; action: 'read'; version: string; offset: number; length: number }
export interface UploadReadResult {
  size: number
  version: string
  mtimeMs: number
  dataBase64?: string
}
