// 软键盘弹着才收起来（入口脚本 scripts/e2e.mjs 的小口经 adb 看了再按返回）。Maestro 的 hideKeyboard 不管有没有键盘都按返回，
// 没弹的时候会退出当前页；键盘是不是自己弹出来又跟设备有没有硬键盘有关（本地的 AVD 有，CI 的没有），所以不能直接用它
const response = http.post(`${HELPER}/hide-keyboard`, { body: '' })
output.keyboard = response.body
