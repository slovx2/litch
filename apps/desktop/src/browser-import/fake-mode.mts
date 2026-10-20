// 样本模式（LITCH_BROWSER_IMPORT_FAKE）要的东西：样本目录、假读取器、内存里的假密码库。
// 单独打成 dist/browser-import-fake.mjs（scripts/build.mjs），主进程只在没打包时按路径动态加载（install.mts）；
// 打包只拷 main、core-host、preload 三个产物，所以正式包里没有这些测试用的代码。
import type { ImportEnv } from './browsers.mjs'
import type { ProtectedReader } from './protected-types.mjs'
import type { PasswordSink } from './sinks.mjs'
import { createFakeReader } from './test/fake-reader.mjs'
import { memoryPasswordSink } from './test/fake-sinks.mjs'
import { ensureSample } from './test/sample.mjs'

export interface SampleMode {
  env: ImportEnv
  reader: ProtectedReader
  passwords: PasswordSink
}

/** 目录里没有样本就摆一套；目录不空又没有样本的标记文件时抛错，不往里写 */
export function createSampleMode(dir: string): SampleMode {
  return { env: ensureSample(dir), reader: createFakeReader(), passwords: memoryPasswordSink() }
}
