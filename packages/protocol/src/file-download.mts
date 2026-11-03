/** 分块另存：每次请求有界读取，revision 防止把不同版本拼在一起。 */
export const FILE_DOWNLOAD_CHUNK = 256 * 1024
export interface FileReadRange {
  root: string
  offset: number
  maxBytes: number
  revision?: string
}
export interface FileReadChunk {
  dataBase64: string
  litchReadRange: { size: number; revision: string }
}
