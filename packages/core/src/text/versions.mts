// 版本号怎么比、适配器是怎么装的：外壳（本机换版本 adapter-upgrade.mts、自动更新）和核心（远程设备的一键升级）
// 共用这一份，不各抄一遍。
//
// 版本号按语义化版本读（主.次.修订，可以带 -预发布 和 +构建信息，前面可以有个 v）。数字逐段比；
// 带预发布的比不带的旧（1.2.0-rc.1 < 1.2.0）；预发布按点分开逐段比，数字段按数值，别的按字符，
// 数字段比非数字段旧，前面都一样时段数少的旧；+ 后面的构建信息不参加比较。
// 拿不到版本号的构建报的是 0.0.0-unknown，照这套规则它比任何正式版本都旧。

interface Version {
  core: [number, number, number]
  /** 预发布的各段。没有预发布是空的 */
  pre: string[]
}

const VERSION =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(text: string): Version | null {
  const found = VERSION.exec(text.trim())
  if (!found) return null
  return {
    core: [Number(found[1]), Number(found[2]), Number(found[3])],
    pre: found[4] ? found[4].split('.') : [],
  }
}

/** 读不读得成语义化版本 */
export const isVersion = (text: string): boolean => parseVersion(text) !== null

const sign = (value: number): -1 | 0 | 1 => (value < 0 ? -1 : value > 0 ? 1 : 0)

/** 预发布的一段和另一段比 */
function comparePart(left: string, right: string): -1 | 0 | 1 {
  const numeric = /^\d+$/
  const [a, b] = [numeric.test(left), numeric.test(right)]
  if (a && b) return sign(Number(left) - Number(right))
  // 数字段比非数字段旧
  if (a !== b) return a ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** 两个版本号比先后：-1 是前一个旧，1 是前一个新，0 一样。有一边读不成语义化版本就是 null */
export function compareVersions(left: string, right: string): -1 | 0 | 1 | null {
  const [a, b] = [parseVersion(left), parseVersion(right)]
  if (!a || !b) return null
  for (const index of [0, 1, 2] as const) {
    const order = sign(a.core[index] - b.core[index])
    if (order !== 0) return order
  }
  // 带预发布的比不带的旧
  if (a.pre.length === 0 || b.pre.length === 0) return sign(b.pre.length - a.pre.length)
  for (let index = 0; index < Math.min(a.pre.length, b.pre.length); index++) {
    const order = comparePart(a.pre[index] as string, b.pre[index] as string)
    if (order !== 0) return order
  }
  return sign(a.pre.length - b.pre.length)
}

/**
 * 远程设备上那份适配器是怎么装的：script 是安装脚本（scripts/install.sh），brew 是 Homebrew。
 * 认不出的（开发目录、手工解压、系统包、别人管的目录）不在这里面
 */
export type AdapterInstallMethod = 'script' | 'brew'

/**
 * 按路径认安装方式。给的可以是服务报的根目录（<安装位置>/libexec），也可以是命令解开链接之后的真实位置
 * （<安装位置>/bin/codex-harness-adapter）：两种都落在同一个“<安装位置> = …/codex-harness-adapter/<版本>”上。
 *   安装脚本：~/.local/share/codex-harness-adapter/<版本>/…
 *   Homebrew：<前缀>/Cellar/codex-harness-adapter/<版本>/…
 * 别的一律认不出（null）：不猜
 */
export function installMethodOf(path: string | null | undefined): AdapterInstallMethod | null {
  if (!path) return null
  if (/\/\.local\/share\/codex-harness-adapter\/[^/]+(?:\/|$)/.test(path)) return 'script'
  if (/\/Cellar\/codex-harness-adapter\/[^/]+(?:\/|$)/.test(path)) return 'brew'
  return null
}
