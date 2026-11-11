// 仅供隔离测试/验收启动 Chromium（含 Electron）；产品浏览器不能引用这里。
export function withChromiumTestArgs(args = []) {
  return [
    ...args.filter((arg) => !/^--(?:use-mock-keychain|password-store)(?:=|$)/.test(arg)),
    '--use-mock-keychain',
    '--password-store=basic',
  ]
}
