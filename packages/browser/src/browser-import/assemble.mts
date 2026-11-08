// 把管线组装起来：正式模式和样本模式都经这里（install.mts），单测也用它对着真的密码库走一遍（test/import-store.test.mts）。
// 密码库是必填的：正式模式交的是内置浏览器的密码库（browser/install.mts），少交了密码那一类就会一律报导不了。
// 不引 electron：Cookie 罐、读取器、密码库都从外面给。
import type { ImportEnv } from './browsers.mjs'
import type { CookieJar } from './cookies.mjs'
import { createImporter, type Importer } from './pipeline.mjs'
import type { ProtectedReader } from './protected-types.mjs'
import type { PasswordSink } from './sinks.mjs'
import { createImportStateBook, importStateFile } from './state.mjs'

export function assembleImporter(options: {
  env: () => ImportEnv
  reader: ProtectedReader
  cookies: CookieJar
  passwords: PasswordSink
  userData: string
  now?: () => number
  log?: (line: string) => void
}): Importer {
  return createImporter({
    env: options.env,
    reader: options.reader,
    cookies: options.cookies,
    passwords: options.passwords,
    state: createImportStateBook(importStateFile(options.userData)),
    ...(options.now ? { now: options.now } : {}),
    ...(options.log ? { log: options.log } : {}),
  })
}
