# 模拟器的隔离 tailnet

这个独立命令仅供测试，不由 `sshtransport` 引用，也不进 gomobile、AAR 或 XCFramework。
它运行临时控制面与 DERP，将 `server.litch.test:2222` 转到已有的隔离 SSH 夹具。
没有真实账号；HTTPS 使用临时 CA，不修改宿主电脑信任库。默认只监听回环。

在 `mobile` 目录运行（端口取 `apps/mobile/scripts/fixture.mjs` 输出）：

```sh
GOTOOLCHAIN=go1.27.3 go run ./testfixture/tailnet \
  --ssh 127.0.0.1:59516 --out /tmp/litch-tailnet.json
```

输出 JSON 包含 `controlURL`、`ca`、`host` 和 `port`。将 CA 加入专用模拟器后，在 Tailscale
设置填 `controlURL`；该控制面自动批准测试节点。SSH 私钥、用户名、主机指纹仍使用原夹具。
测试没有关闭控制面证书校验；只有 DERP 测试地图沿用上游测试专用证书策略。

iOS 原生执行器见 `apps/mobile/scripts/check-ios-network.mjs`。测试结束会重置专用网络
模拟器的 Keychain；整轮结束应关闭并删除模拟器。不能把 CA 装入用户真机。

Android 模拟器访问宿主时使用：

```sh
GOTOOLCHAIN=go1.27.3 go run ./testfixture/tailnet \
  --listen 0.0.0.0 --advertise 10.0.2.2 \
  --ssh 127.0.0.1:59516 --out /tmp/litch-tailnet-android.json
```

默认新建短期 CA；也可传 `--ca <PEM>`、`--ca-key <ECDSA PKCS8 PEM>`，叶证书同时包含回环、
Android 宿主地址和指定的 advertise 地址。Android 必须使用能让 Go 验证该 CA 的隔离系统
信任配置；仅 WebView 信任用户 CA 不足以证明 Go 控制面连接可用。用完删除测试 AVD。
监听非回环时仅在受控测试网络运行；控制面自动批准节点，不适合公开部署。

SIGINT/SIGTERM 会关闭节点与监听器，删除自身生成的 CA、密钥、节点目录及输出配置。
外部传入的 CA 文件由调用方清理；不会修改或删除。测试账号环境变量和代理会被清空。
