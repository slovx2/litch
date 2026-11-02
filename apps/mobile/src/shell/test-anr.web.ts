// 浏览器预览没有 Android 主线程，不做故障注入。
export function injectTestAnr(_mode: string): void {}
