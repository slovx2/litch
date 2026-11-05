// 只读真实 HID 闲置时长，不用会被合成事件影响的 CGEvent 分类计时器。
import { execFileSync } from 'node:child_process'

export function parseHidIdleSeconds(output) {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(output)
  if (!match) throw new Error('IOHIDSystem 没有返回 HIDIdleTime，不能开始桌面验收')
  return Number(BigInt(match[1]) / 1_000_000n) / 1000
}

export function hidIdleSeconds() {
  return parseHidIdleSeconds(
    execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8' }),
  )
}
