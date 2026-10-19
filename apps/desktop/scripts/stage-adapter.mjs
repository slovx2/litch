// 把适配器暂存成一个目录，之后原样装进应用（Litch.app/Contents/Resources/adapter，见 pack.mjs）。
// 可以单独运行；没打包时把 LITCH_ADAPTER_ROOT 指到这个目录，桌面外壳就拿它当内置的适配器。
//   node scripts/stage-adapter.mjs [--out 目录]     默认放在 out/adapter，目录名必须是 adapter
//     --go-from 目录       命令行从哪份源码编译（里面要有 go.mod 和 cmd/codex-harness-adapter），默认是这个仓库
//     --device-from 目录   设备进程的包从哪儿取（里面要有 package.json 和构建好的 dist），默认是 packages/device
//   后两个是给“工作区里这两处正被改到一半”的时候用的：指到一份已提交版本的导出副本上，
//   别的照旧从仓库取。做法见 scripts/client-local-fixture.mjs 开头。
//
// 目录里有什么、怎么暂存出来的，在仓库根目录的 scripts/adapter-stage.mjs：独立发布包用的是同一份实现，
// 两边的布局一样。这里只管桌面应用这一头的事：默认放在哪、目录名的规矩、旧的那份能不能清掉，
// 以及只有桌面应用带的产品手册（skills/litch-manual，放在 skills/ 下；主进程启动时把它装进本机的 harness，
// 见 src/manual-skill.mts）。独立发布包不带它：手册只装本机。
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { megabytes, STAGED_ENTRIES, stageAdapterTree } from '../../../scripts/adapter-stage.mjs'
import { NODE_VERSION } from './node-runtime.mjs'
import { OUT_DIR } from './packed.mjs'

/** 默认的暂存位置。打包器按目录名把它放进应用，所以名字必须是 adapter */
export const ADAPTER_STAGE = join(OUT_DIR, 'adapter')
/** 产品手册的源，暂存到 <暂存目录>/skills/litch-manual */
const MANUAL_SOURCE = fileURLToPath(new URL('../../../skills/litch-manual', import.meta.url))
/** 暂存目录最外面一层的名字：适配器的那些，加上手册的 skills */
const ENTRIES = [...STAGED_ENTRIES, 'skills']

/** 这个位置能不能清空了重来：不存在、空的，或者看着就是上一次暂存出来的 */
function assertDisposable(out) {
  if (basename(out) !== 'adapter') throw new Error(`暂存目录的名字必须是 adapter：${out}`)
  if (!existsSync(out)) return
  if (!statSync(out).isDirectory()) throw new Error(`${out} 不是目录`)
  const entries = readdirSync(out)
  if (entries.length === 0) return
  const strange = entries.filter((name) => !ENTRIES.includes(name))
  // 仓库根目录也长这样，单独挡住
  if (strange.length > 0 || existsSync(join(out, '.git')) || existsSync(join(out, 'cmd'))) {
    throw new Error(`${out} 里有不认识的东西（${strange.join('、')}），不敢清空。换一个位置`)
  }
}

/**
 * 暂存一份适配器，返回它在哪、各部分多大。
 * 默认给本机的系统和架构；给别的架构时 Go 交叉编译，Node 取对应的官方包（不在本机试运行）。
 */
export async function stageAdapter({
  out = ADAPTER_STAGE,
  platform,
  arch,
  goFrom,
  deviceFrom,
} = {}) {
  const target = resolve(out)
  assertDisposable(target)
  rmSync(target, { recursive: true, force: true })
  try {
    const result = await stageAdapterTree(target, { platform, arch, goFrom, deviceFrom })
    const manual = join(target, 'skills', 'litch-manual')
    cpSync(MANUAL_SOURCE, manual, { recursive: true, filter: (src) => !src.endsWith('.DS_Store') })
    if (!existsSync(join(manual, 'SKILL.md'))) throw new Error(`产品手册没有暂存成：${manual}`)
    return result
  } catch (error) {
    // 半成品不留着，免得被当成一份完整的适配器拿去用
    rmSync(target, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  /** 命令行里 `--名字 值` 的那个值，没给就是 undefined（用默认的） */
  const option = (name) => {
    const at = process.argv.indexOf(name)
    return at > 0 ? process.argv[at + 1] : undefined
  }
  try {
    const result = await stageAdapter({
      out: option('--out'),
      goFrom: option('--go-from'),
      deviceFrom: option('--device-from'),
    })
    for (const [name, bytes] of Object.entries(result.parts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${megabytes(bytes).padStart(9)}  ${name}`)
    }
    console.log(`适配器已暂存：${result.out}（${megabytes(result.total)}，Node ${NODE_VERSION}）`)
  } catch (error) {
    console.error(`适配器没有暂存成：${error.message}`)
    process.exit(1)
  }
}
