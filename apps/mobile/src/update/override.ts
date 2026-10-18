// 开发和验收用的更新清单地址：测试链接 litch://update?feed=<地址> 换成本机起的假清单（允许 http），
// litch://update?reset=1 换回正式的那份。记在文档目录的一个 JSON 文件里，重启应用也还在。
// 单独放一个文件：测试链接（src/shell/dev-links.ts）只引这里，不把下载、原生模块那一套带进单元测试。
import { jsonFile } from '../shell/json-file'

const file = jsonFile<{ feed: string }>('update-feed.json')
const listeners = new Set<() => void>()

/** 换过的清单地址；没换过是 null */
export function feedOverride(): string | null {
  return file.read()?.feed ?? null
}

/** 换清单地址（null 是换回正式的那份）；地址要是 http 或 https，不是就不换、返回 false */
export function setFeedOverride(feed: string | null): boolean {
  if (feed === null) file.remove()
  else if (/^https?:\/\/\S+$/.test(feed)) file.write({ feed })
  else return false
  for (const listener of listeners) listener()
  return true
}

/** 清单地址换了就告诉一声（更新的状态要从头来） */
export function onFeedOverride(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
