// 网页预览里的更新模块替身：装不了包，算不了文件
import type { Updater } from './index'

const unsupported = () => Promise.reject(new Error('界面预览不能安装更新'))

export const native: Updater = {
  canInstall: () => false,
  openInstallSettings: () => false,
  sha256: unsupported,
  inspect: unsupported,
  install: () => {},
}
