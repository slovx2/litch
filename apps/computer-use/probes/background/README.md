# 后台输入 M0 探针

仅研究用途，不进入产品助手的 Package.swift、不注册工具、不修改用户的 TCC/系统设置。
驱动、AppKit 目标、前台守卫与 Electron 页面是独立进程。只有驱动需要辅助功能权限，
通过 LaunchServices 启动，权限记在 `Litch Background Input Probe` 名下；不要给 Terminal 或正式 Litch 额外权限。

## 构建与权限

依赖系统 Swift/AppKit，Electron 使用已有的 **44.7.0** 二进制，Node 使用 24，不安装新依赖。

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
# 由环境提供本机已有 Developer ID 身份；不设时用临时签名，重编译后可能需要重新授权。
node apps/computer-use/probes/background/build.mjs
```

输出在 `apps/computer-use/.artifacts/background/`，独立包标识
`io.github.slovx2.litch.background-input-probe`。系统设置 → 隐私与安全性 → 辅助功能，
手动添加 `Litch Background Input Probe.app` 并开启。**无需屏幕录制权限**：
目标窗口自行报告坐标、控件值与事件，驱动只读 WindowServer 的窗口编号元数据。

这项授权允许驱动投递事件；代码只接受本轮状态目录下的夹具目标、校验运行包标识，
不提供任意应用操控接口。测试完成后可以撤销该探针的辅助功能权限，不影响正式 Litch。

## 启动、运行、关闭

每轮使用新的绝对状态目录；测试进程不用个人 CODEX_HOME、浏览器 profile 或 SSH 配置。

```sh
export LITCH_PROBE_ELECTRON=/绝对路径/Electron.app/Contents/MacOS/Electron
node apps/computer-use/probes/background/run.mjs setup /tmp/litch-cu-m0-run1
node apps/computer-use/probes/background/run.mjs matrix /tmp/litch-cu-m0-run1
node apps/computer-use/probes/background/run.mjs stop /tmp/litch-cu-m0-run1
```

没有开 CDP 端口。未授权时 matrix 在激活守卫和投递事件之前失败。
运行 matrix 会在自有夹具之间建立“目标先激活、守卫再到前台”的前置条件，
真正输入阶段绝不调用激活。用户切到其他应用后立即停止后续动作，不把守卫拉回来。
开始前应确认用户没有在使用电脑；不要把他人移动真实鼠标造成的轨迹变化归因于注入。

可选环境变量：

- `LITCH_PROBE_REPETITIONS=3`：每种动作重复三次。
- `LITCH_PROBE_TARGETS=appkit,electron`：目标子集。
- `LITCH_PROBE_BACKENDS=public,public-window,public-ax,private-focus,private`：路径子集。
- `LITCH_PROBE_COLD=1`：不事先激活目标；要使用刚 setup 的夹具，不能在已运行 warm 矩阵的窗口上假装 cold。

## 五种路径严格区分

| 名称 | 行为 |
|---|---|
| public | 公开 CGEvent.postToPid，屏幕坐标，不额外写窗口字段 |
| public-window | 同上，加公开 mouseEventWindowUnderMousePointer/ThatCanHandleThisEvent 字段 |
| public-ax | 公开 AXMain/AXFocused 设置，再用公开窗口字段和 postToPid；单独记录 AX 返回码 |
| private-focus | 给目标窗口发 SLPSPostEventRecordTo 焦点记录，再用 public-window 投递 |
| private | 合成焦点 + CGEventSetWindowLocation + SLEventPostToPid |

缺少私有符号直接记 unavailable，不偷偷回退。私有焦点测试后给目标发撤销记录，
不向用户前台应用发送失活记录。**这是候选私有增强的对照，不是完整复刻官方实现。**
目前没有加入私有键盘认证 envelope、IME 候选窗、菜单抑制等分支；不能用这几个候选失败
证明一切私有增强都无效。是否追加候选，应由首轮实际事件证据决定。

私有接口的 ABI/事件记录布局参考公开的开源研究，自行写最小探针，未复制 ChatGPT 专有实现：

- [Cua 的 macOS 窗口内部机制研究](https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md)。
- [Amethyst 的公开接口声明](https://github.com/ianyh/Amethyst/blob/development/Amethyst/Model/Window.swift)。
- 本机 Qwen 仓库 `packages/cua-driver/rust/crates/platform-macos/src/input/skylight.rs`
  对这些 ABI 的声明与目标专用焦点记录布局（其 workspace 标明 MIT）。不依赖或分发该库。

## 判断成功不能只看“调用返回”

每行保存完整前后状态、目标实际收到的事件、前台 PID 和系统光标采样：

- click：真实按钮计数恰好增加 1。
- scroll：真实滚动位置增大。
- english/chinese：文本控件精确得到 `abcXYZ` / `中文测试`。
- keycode：真实虚拟键码输入得到 `a`；与 Unicode 合成文本分开测。
- 输入后仅当前台仍为自有守卫时，再投递一对全局 `v` 键；应由守卫收到、目标不能收到。
  此项用于发现 frontPid 没变但系统键盘路由串线，不代表已验证真人并发输入。
- 任一测试期间前台偏离守卫即失败并停止余下矩阵。真实光标位移单独记录，不能隐藏或复位。

证据文件 `matrix-<uuid>.json` 按每一行写盘，即使中断也保留已有结果。
JSON 中 `changed` 只证明目标结果；后台通过需要同时满足 `frontStable`、`guardRouteOK`，
并对真实光标变化作归因。5ms 采样不能证明采样间隙不存在瞬态焦点变化。

必须在报告中注明 macOS/CPU、Electron/Chromium、签名、SIP、权限、warm/cold 条件、
是否遮挡和重复次数。当前 Electron 显式关闭后台节流/遮挡节流；结果不能泛化到所有 Chromium 配置。
中文测试是 Unicode 事件，不是中文输入法组合输入。SIP 开启环境未测就写“未验”，不要混入关闭结果。

## 本次准备验证（2026-10-29）

macOS 26.5.1 (25F80)、SIP disabled。Swift 探针/夹具已编译并 Developer ID 签名验证，
AppKit、前台守卫、Electron 三个真实进程均已启动并报告初始控件状态。
输入权限检查尚为 false，matrix 的无权限拒绝路径已验证，没有投递真实输入。
**动作矩阵与 P2 结论待用户授权后实测；SIP-on 未验。**
