# CI 的 bubblewrap 离线包

`bubblewrap_0.9.0-1ubuntu0.3_amd64.deb` 是未修改的 Ubuntu 24.04 官方包，仅供 CI 的 amd64 Linux runner 离线安装。

- 来源：<https://security.ubuntu.com/ubuntu/pool/main/b/bubblewrap/bubblewrap_0.9.0-1ubuntu0.3_amd64.deb>
- 官方摘要：<https://packages.ubuntu.com/noble/amd64/bubblewrap/download>
- SHA256：`2461f1beee9cb04c8942739fe1a2b37e7b7c2a3d518f0779dc75f9245baa3094`
- 许可证：GNU LGPL 2.0 或更新版本（`LGPL-2.0+`）；版权说明保留在包内的 `/usr/share/doc/bubblewrap/copyright`，并附副本 `bubblewrap.copyright` 和 `LGPL-2.txt`。
- 对应源码及 Ubuntu 打包修改：<https://launchpad.net/ubuntu/+source/bubblewrap/0.9.0-1ubuntu0.3>，包括原始源码、Debian 补丁归档及 `.dsc`；可从 Ubuntu 取得。

安装入口是 `../install-bubblewrap.sh`。amd64 路径先校验摘要、包名、版本、架构，再执行 `dpkg -i` 并检查最终安装状态；不访问 apt 或下载地址。其他架构仍使用精确版本的 apt 安装，不使用此包。
