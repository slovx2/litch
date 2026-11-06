// 在创建夹具或 Electron 之前拒绝旧 UI；已打包应用验的是包内 UI，不读取工作树 dist。
import { assertUiBuildFresh } from '../../../scripts/ui-build-state.mjs'

if (!process.versions.electron && !process.argv.includes('--packed')) assertUiBuildFresh()
