# Android 选字坐标回归

`SelectionScrollTest.kt` 直接测试补丁中的原生坐标换算，使用 Markdown 依赖已有的精确版本
JUnit 4.13.2 / Robolectric 4.14.1，不连接设备或模型。

先安装手机依赖并生成 Android 工程，再给命令设置 JDK 17 的 `JAVA_HOME` 和 Android SDK 的
`ANDROID_HOME`，在 `apps/mobile` 执行：

```sh
npm run prebuild
npm run test:selection
```

覆盖列表两层翻转、历史滚动偏移、窗口原点、上下边缘、后台任务条缩小可见区、缩放、
仅滚动正在调整的端点，以及原生 Canvas 对把手的裁剪和滚回后的恢复。
测试通过 init 脚本加入原生模块的测试源码集，不修改生成的 Android 工程。

模拟器复验使用 `litch://boot?mode=mock`、`litch://new?prompt=long%20history`。
往上翻到多级列表，长按 → 选择文字，拖动两个把手，再滚动正文后继续拖动；同时检查上、下边缘。
可在新建的模拟会话发送 `background tasks`，验证后台任务条出现及消失时的边界。
把手停在文字边界并有原生触摸偏移，不要求圆点中心与手指完全重合；不得出现数百像素偏移、
因另一选区端点引起的列表跳动，或把手停留在标题栏、后台任务条、输入区。

把手图形裁剪使用 Android 10 起公开的图形 setter，和组件原有的把手着色 API 一致；
更早的 Android 仍使用系统把手。滚动坐标修复不依赖这个 API。
