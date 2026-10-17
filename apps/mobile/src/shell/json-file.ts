// 存在应用文档目录里的一个 JSON 文件：同步读写（核心的设备存储接口是同步的）。
// 写的时候先写临时文件再改名，写到一半被杀掉也不会留下半个文件。读不出来（没有、坏了）就当没有。
// 只放不敏感的东西；密钥、口令放 expo-secure-store。
import { File, Paths } from 'expo-file-system'

export interface JsonFile<T> {
  read(): T | null
  write(value: T): void
  remove(): void
}

export function jsonFile<T>(name: string): JsonFile<T> {
  const file = new File(Paths.document, name)
  return {
    read() {
      try {
        if (!file.exists) return null
        return JSON.parse(file.textSync()) as T
      } catch {
        return null
      }
    },
    write(value) {
      // 每次新建对象：改名之后原来那个对象指的就是新名字了
      const temp = new File(Paths.document, `${name}.tmp`)
      temp.create({ overwrite: true })
      temp.write(JSON.stringify(value))
      if (file.exists) file.delete()
      temp.rename(name)
    },
    remove() {
      if (file.exists) file.delete()
    },
  }
}
