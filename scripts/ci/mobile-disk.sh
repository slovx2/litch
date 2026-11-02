#!/usr/bin/env bash
# GitHub 托管 Linux 的手机分片不使用这些预装工具；沿用 APK 构建 job 的清理范围。
# 不修改 userdata 大小，不删除 Android SDK、AVD、源码或本轮测试产物。
set -euo pipefail
df -h /
trap 'df -h /' EXIT
sudo rm -rf /usr/share/dotnet /opt/ghc /usr/local/.ghcup /opt/hostedtoolcache/CodeQL /usr/local/share/powershell /usr/local/lib/node_modules
