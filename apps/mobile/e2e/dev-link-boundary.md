# 移动端测试深链边界

## 构建与入口

`EXPO_PUBLIC_LITCH_E2E` 只有显式 `1` 才开放测试入口，未设置或 `0` 关闭；不依赖 `__DEV__`。
Expo 将变量内联进 JS，Metro 与 Gradle 的 bundle 任务都把档位作为缓存输入。
`app.config.js` 同时写入 `extra.litchE2E`，有 Android 分发钥匙或 iOS 分发构建号时拒绝 E2E。
Android 发布检查和 E2E 执行器读取 APK 内的 `assets/app.config`，拒绝错档或缺失标记。
这个产物检查用于防止误分发；实际行为仍由模拟器测试验证，不以配置标记代替行为证据。

| 外部入口 | 发布包（Android / iOS） | Release E2E |
|---|---|---|
| `update?feed=`、`update?reset=1` | 不注册 URL 监听；处理函数和更新源存储也拒绝 | 可以切换清单；iOS 更新模块不请求或安装 APK |
| `boot?mode=mock/fixture/stored` | 忽略；旧偏好归一为 stored；boot 再次强制 stored | 可用模拟核心、SSH 夹具或真实设备 |
| `remote?adapter=…&env=…` | 忽略；旧远端调试配置清除，读取返回空 | 修改后续 SSH 连接用的命令名和环境变量 |
| 实验参数、探针、测试钩子、new/send/open 等 | 在解析参数和调用副作用之前拒绝 | 按入口处理；测试钩子的 mock/fixture 限制继续有效 |

这些应用层限制在 `644533cd` 已同时覆盖两端。本次补齐 Android 产物检查、冷/热启动负测、
E2E 换源正测及下载状态机验证，没有增加第二个运行时开关或令牌协议。

## 换源和安装校验

代码事实（`src/update/store.ts`、`modules/litch-update/`）：

- 换源立即检查清单，并持久保存；清单与其中的 APK URL 可以使用 HTTP。
- 用户点击更新才下载，不会因深链或检查清单自动下载、静默安装。
- 下载后检查清单声明的大小和 SHA-256、APK 包名、实际 versionCode 大于已安装版本。
- Android 9 及以上读取 APK 和当前应用的签名证书集合，签名不同会在应用层拒绝。
- `sameSigner=null`（Android 9 以前或签名不可读）会继续拉起系统安装器。
  单测只证明这一调用行为，不能证明 OS 已接受安装；Android 安装器仍是最后的安装边界。
  系统的安装/升级签名要求见 [Android 官方签名说明](https://developer.android.com/studio/publish/app-signing)。
- iOS 检查、下载和安装函数直接返回，原生 install 也不提供 APK 安装能力。

风险判断：开放的 E2E 包仍是测试工具，任何能打开其 URI scheme 的来源都能改测试配置。
对于未收紧的旧包，攻击者可持久改变更新检查目标、隐藏更新或伪造高版本提示，
让用户主动下载恶意/超大文件；SHA-256 和大小也来自被控制的清单，不能作为发行者身份。
这本身不等于能用异签名 APK 替换现有应用。远端开发参数还可改变随后 SSH 连接执行的命令和环境。
发布包关闭入口后，这些外部深链不再触发上述副作用；E2E APK 不应交付用户。

## 验证位置

- `test/review-build.test.mjs`：两种 scheme、发布/E2E 档位、持久文件、通知、实验参数和旧配置清理。
- `test/apk-build-mode.test.mjs`：默认关闭、分发参数拒绝 E2E、产物错档拒绝。
- `test/update-verification.test.mjs`：真实 JS 下载状态机与原生替身，检查未被换源绕过。
- `mock/33-update-links.yaml`：Android E2E 换源、提示、重启持久化；宿主验证有清单请求、没有 APK 请求。
- `production/android-dev-links.yaml`：Android 发布包冷/热深链无效；宿主验证清单请求为零。
- `production/review-links.yaml` / `check-review-production.mjs`：既有 iOS 发布包负测和旧配置清理。

以上单测不覆盖真实异签名 APK 安装、旧 Android 系统签名回退、iOS 分发签名或商店上传；
这些应在交付报告中与已运行的模拟器流程分别说明。
