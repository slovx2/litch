// 让系统输入法弹出软键盘（只有安卓）。终端页按 ⌨ 时，WebView 拿到焦点、页面里的输入框 focus() 之后调一次
import { requireNativeModule } from 'expo-modules-core'

const native = requireNativeModule<{ show(): boolean }>('LitchKeyboard')

/** 给眼下拿着焦点的视图弹出软键盘；没有拿着焦点的视图就返回 false */
export const showKeyboard = (): boolean => native.show()
