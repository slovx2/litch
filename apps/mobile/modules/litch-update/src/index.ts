// 应用自己的更新（只有安卓）：算 SHA-256、看安装包、拉起系统安装器。怎么用见 src/update/
import { native } from './native'

export interface ApkInfo {
  packageName: string
  versionName: string | null
  versionCode: number
  /** 眼前装着的这个应用的 versionCode */
  installedVersionCode: number
  /** 签名和眼前这个应用是不是同一把钥匙；系统给不出时是 null */
  sameSigner: boolean | null
}

export interface Updater {
  /** 能不能拉起系统安装器装包（“安装未知应用”有没有允许） */
  canInstall(): boolean
  /** 打开系统设置里本应用的“安装未知应用”那一页；系统没有这一页时返回 false */
  openInstallSettings(): boolean
  /** 文件的 SHA-256（小写十六进制），收 file:// 地址或裸路径 */
  sha256(path: string): Promise<string>
  inspect(path: string): Promise<ApkInfo>
  /** 拉起系统安装器；文件要在缓存目录或文档目录里 */
  install(path: string): void
}

export const updater: Updater = native
