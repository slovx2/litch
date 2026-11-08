// 只在带标准 URL API 的浏览器和桌面运行环境使用。
export function chromeOrigin(url: string): string | null {
  if (url === 'about:blank') return 'about:blank'
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password
      ? parsed.origin
      : null
  } catch {
    return null
  }
}
