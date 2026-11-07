# 输入框原生布局回归

先按手机构建流程生成并安装启用 `EXPO_PUBLIC_LITCH_E2E=1` 的 release APK，
只使用隐藏的 `litch_` 专用 Android 模拟器。测试不连接真实设备服务。

在 `apps/mobile` 目录执行（Android SDK、JDK 17 环境同正常构建）：

```sh
./android/gradlew -p android -I ../test/native/composer-layout.init.gradle \
  :app:assembleReleaseAndroidTest --no-daemon -PreactNativeArchitectures=arm64-v8a
adb -s emulator-5584 install -r android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk
adb -s emulator-5584 shell am instrument -w \
  -e class dev.litch.composer.ComposerNativeLayoutTest \
  dev.litch.app.test/android.test.InstrumentationTestRunner
node scripts/check-composer-size.mjs emulator-5584
```

原生测试在真实 Activity 中打开模拟核心的空闲和运行会话，给输入框写入空、短、长、多行文本，
重放 Android 原生 measure/layout，断言输入框保留 Yoga 分配的宽度。
它覆盖 ExpoView 继承的 LinearLayout 二次布局路径；不是特定输入法触发时序的模拟。
测试断言必须在 instrumentation 线程上执行，避免断言异常变成应用崩溃。

几何脚本补验正常输入、自动增高、封顶、清空、键盘反复展开和回前台，以及用量菜单。
它自动持有 `/tmp/litch-maestro-7001.lock`；已有活跃 owner 时不要删除或抢锁。
运行后关闭本次启动的模拟器，不保留截图、日志和 APK 副本。

iOS 复用 `scripts/check-composer-ios.mjs <UDID>`，只接受 `Litch-iOS-` 专用模拟器，
预先安装启用 E2E 的 `dev.litch.app.dev` 包。可在手机、平板运行相同几何断言。
