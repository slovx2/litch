// 只重试 SDK 安装阶段的已识别下载/归档读取错误；绝不包住模拟器或 Maestro。
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

export const sdkPackages = [
  'build-tools;37.0.0',
  'platform-tools',
  'platforms;android-35',
  'emulator',
  'system-images;android-35;google_apis;x86_64',
]

export function sdkRetryReason(output) {
  // 即使同时含网络错误，磁盘/权限/许可证问题也不能靠重新下载掩盖。
  if (/No space left|Permission denied|AccessDenied|licenses? .*not accepted/i.test(output))
    return null
  if (
    /An error occurred while preparing SDK package[^\n]*Error reading Zip content from a SeekableByteChannel/.test(
      output,
    )
  )
    return 'SDK 下载归档读取失败（SeekableByteChannel）'
  if (
    /timed out|connection reset|connection refused|unexpected end|HTTP.*(408|429|500|502|503|504)|SSLHandshakeException|SocketException/i.test(
      output,
    )
  )
    return 'SDK 网络下载错误'
  return null
}

export function clearSdkDownloadState(sdkRoot, pkg) {
  if (!isAbsolute(sdkRoot) || resolve(sdkRoot) === parse(sdkRoot).root)
    throw new Error('SDK 根目录必须是绝对的非根路径')
  if (!sdkPackages.includes(pkg)) throw new Error(`未允许的 SDK 包：${pkg}`)
  // 此步骤独占 SDK 安装，不清已安装包；丢弃失败下载与恢复标记，避免原地复用坏归档。
  const targets = [
    join(sdkRoot, '.temp'),
    join(sdkRoot, '.downloadIntermediates'),
    join(sdkRoot, ...pkg.split(';'), '.installer'),
  ]
  for (const target of targets) {
    let parent = sdkRoot
    for (const part of target.slice(sdkRoot.length + 1).split('/')) {
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
        throw new Error(`SDK 清理拒绝符号链接：${parent}`)
      parent = join(parent, part)
    }
  }
  // rmSync 删除末级链接本身，不跟随链接；全部目标通过检查后才清理。
  for (const target of targets) rmSync(target, { recursive: true, force: true })
}

export async function installSdkPackage({
  sdkRoot,
  pkg,
  directory,
  run,
  delay = setTimeout,
  report,
}) {
  if (!sdkPackages.includes(pkg)) throw new Error(`未允许的 SDK 包：${pkg}`)
  mkdirSync(directory, { recursive: true })
  const name = pkg.replaceAll(';', '-')
  for (let attempt = 1; attempt <= 4; attempt++) {
    const started = Date.now()
    const result = run(pkg)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    writeFileSync(join(directory, `${name}-attempt-${attempt}.log`), output)
    const reason = result.status === 0 ? null : sdkRetryReason(output)
    report(
      `SDK ${pkg}：尝试 ${attempt}，退出码 ${result.status}，${((Date.now() - started) / 1000).toFixed(1)} 秒，已重试 ${attempt - 1} 次${reason ? `；${reason}` : ''}。`,
    )
    if (result.error) throw result.error
    if (result.status === 0) return
    if (!reason || attempt === 4) throw new Error(`SDK ${pkg} 安装失败，不再重试`)
    clearSdkDownloadState(sdkRoot, pkg)
    await delay(15_000)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 只服务一次性 GitHub runner，不动开发者个人 SDK。
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP)
    throw new Error('只允许在 GitHub runner 上准备 SDK')
  const sdkRoot = resolve(process.env.ANDROID_HOME ?? '')
  const sdkmanager = join(sdkRoot, 'cmdline-tools/latest/bin/sdkmanager')
  if (!process.env.ANDROID_HOME || !existsSync(sdkmanager)) throw new Error('缺少 Android SDK')
  for (const pkg of sdkPackages) {
    await installSdkPackage({
      sdkRoot,
      pkg,
      directory: join(process.env.RUNNER_TEMP, 'maestro-out/sdk-install'),
      run: (name) => {
        const result = spawnSync(sdkmanager, ['--verbose', '--install', name, '--channel=0'], {
          encoding: 'utf8',
          timeout: 300_000,
          killSignal: 'SIGKILL',
          maxBuffer: 32 * 1024 * 1024,
        })
        process.stdout.write(result.stdout ?? '')
        process.stderr.write(result.stderr ?? '')
        return result
      },
      report: (message) => {
        console.log(message)
        if (process.env.GITHUB_STEP_SUMMARY)
          appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`)
      },
    })
  }
}
