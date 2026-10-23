// 网页预览里的 json-file.ts：只放在内存里（expo-file-system 在网页上没有）。
// 预览每次打开都从头来，明暗、语言跟着地址走（src/preview/frame.web.ts）；
// 并排的两块屏是两个 iframe，各有各的一份，不会互相覆盖（localStorage 是同源共用的）。
import type { JsonFile } from './json-file'

const files = new Map<string, string>()

export function jsonFile<T>(name: string): JsonFile<T> {
  return {
    read() {
      const text = files.get(name)
      return text === undefined ? null : (JSON.parse(text) as T)
    },
    write(value: T) {
      files.set(name, JSON.stringify(value))
    },
    remove() {
      files.delete(name)
    },
  }
}
