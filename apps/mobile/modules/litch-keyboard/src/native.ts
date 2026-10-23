// 原生那一层的软键盘模块（Expo 原生模块 LitchKeyboard）。网页预览里换成 native.web.ts 的替身
import { requireNativeModule } from 'expo-modules-core'

export const native = requireNativeModule<{ show(): boolean }>('LitchKeyboard')
