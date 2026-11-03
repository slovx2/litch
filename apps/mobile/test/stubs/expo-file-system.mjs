// expo-file-system 的内存替身：只有 src/shell/json-file.ts 用到的那几样。
// 内容放在 files 里，测试可以直接看、直接清（files.clear()）。
export const files = new Map()

export const Paths = { document: 'doc:' }

export class File {
  constructor(dir, name) {
    this.path = name === undefined ? dir : `${dir}/${name}`
  }
  get size() {
    return Buffer.byteLength(files.get(this.path) ?? '')
  }
  async base64() {
    return Buffer.from(this.textSync()).toString('base64')
  }
  get exists() {
    return files.has(this.path)
  }
  textSync() {
    if (!files.has(this.path)) throw new Error(`没有这个文件：${this.path}`)
    return files.get(this.path)
  }
  create() {
    files.set(this.path, '')
  }
  write(text) {
    files.set(this.path, text)
  }
  delete() {
    files.delete(this.path)
  }
  rename(name) {
    const text = files.get(this.path)
    files.delete(this.path)
    this.path = `${this.path.slice(0, this.path.lastIndexOf('/'))}/${name}`
    files.set(this.path, text)
  }
}
