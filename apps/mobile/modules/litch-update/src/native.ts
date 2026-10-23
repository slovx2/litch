// 原生那一层的更新模块（Expo 原生模块 LitchUpdate）。网页预览里换成 native.web.ts 的替身
import { requireNativeModule } from 'expo-modules-core'
import type { Updater } from './index'

export const native = requireNativeModule<Updater>('LitchUpdate')
