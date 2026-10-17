// 单元测试的装载钩子：让 Node 自带的测试运行器直接跑 src 下的 .ts（类型剥离，不构建、不打包）。
// 跑法：npm test（apps/mobile），要 Node 24。补的只有 Metro 和 tsconfig 替我们做了、Node 不做的几件事：
//   - `@litch/core` 指到 packages/core/src/index.mts（和 metro.config.js、tsconfig.json 的映射一致）；
//   - 相对引用不带扩展名时依次试 .ts、.tsx、/index.ts；核心里写成 .mjs 的引用落到同名的 .mts；
//   - 原生模块（expo-*）和导航换成 test/stubs/ 下的替身。测的是纯逻辑，替身只做到够用。
import { statSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = new URL('./', import.meta.url)
const core = new URL('../../../packages/core/src/index.mts', import.meta.url)
const stubs = {
  'expo-file-system': new URL('stubs/expo-file-system.mjs', here),
  'expo-modules-core': new URL('stubs/expo-modules-core.mjs', here),
  '@react-navigation/native': new URL('stubs/react-navigation-native.mjs', here),
}

const tryFile = (url) =>
  statSync(fileURLToPath(url), { throwIfNoEntry: false })?.isFile() ? url.href : null

/** apps/mobile 的 package.json 没写 type：.ts 一律按 ES 模块读，免得 Node 先按 CommonJS 试一遍再报警告 */
const typed = (url) => ({
  url,
  shortCircuit: true,
  ...(url.endsWith('.ts') ? { format: 'module-typescript' } : {}),
})

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@litch/core') return { url: core.href, shortCircuit: true }
    const stub = stubs[specifier]
    if (stub) return { url: stub.href, shortCircuit: true }
    const relative = specifier.startsWith('./') || specifier.startsWith('../')
    if (relative && context.parentURL?.startsWith('file:')) {
      const base = new URL(specifier, context.parentURL)
      if (!tryFile(base)) {
        const found = specifier.endsWith('.mjs')
          ? tryFile(new URL(base.href.replace(/\.mjs$/, '.mts')))
          : (tryFile(new URL(`${base.href}.ts`)) ??
            tryFile(new URL(`${base.href}.tsx`)) ??
            tryFile(new URL(`${base.href}/index.ts`)))
        if (found) return typed(found)
      }
    }
    const resolved = next(specifier, context)
    // 地址可能带查询串（测试里重新载入模块用的 ?run=n），看路径的结尾
    return resolved.url.startsWith('file:') && new URL(resolved.url).pathname.endsWith('.ts')
      ? { ...resolved, format: 'module-typescript' }
      : resolved
  },
})
