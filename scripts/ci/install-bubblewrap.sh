#!/usr/bin/env bash
# Ubuntu 24.04 amd64 的固定沙箱依赖直接取仓库内包，安装不访问网络。
set -euo pipefail

version=0.9.0-1ubuntu0.3
sha256=2461f1beee9cb04c8942739fe1a2b37e7b7c2a3d518f0779dc75f9245baa3094

verify_install() {
  local installed
  installed=$(dpkg-query -W -f='${Status} ${Version}' bubblewrap)
  if [ "$installed" != "install ok installed $version" ]; then
    echo "bubblewrap 安装状态或版本不符：$installed" >&2
    return 1
  fi
  bwrap --version
}

# 当前8个Linux调用均为ubuntu-24.04（amd64）；未来其他架构仍按精确版本走apt，不装amd64包。
if [ "$(dpkg --print-architecture)" != amd64 ]; then
  sudo timeout 120s apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=15 \
    -o Acquire::https::Timeout=15 -o APT::Update::Error-Mode=any update
  sudo timeout 120s apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=15 \
    -o Acquire::https::Timeout=15 install --yes --no-install-recommends "bubblewrap=$version"
  verify_install
  exit 0
fi

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
deb="$here/vendor/bubblewrap_${version}_amd64.deb"
printf '%s  %s\n' "$sha256" "$deb" | sha256sum --check --strict -
if [ "$(dpkg --field "$deb" Package)" != bubblewrap ] ||
  [ "$(dpkg --field "$deb" Version)" != "$version" ] ||
  [ "$(dpkg --field "$deb" Architecture)" != amd64 ]; then
  echo '仓库内 bubblewrap 包名称、版本或架构不符，拒绝安装' >&2
  exit 1
fi
# runner 已提供 libc6/libcap2/libselinux1；缺依赖时 dpkg 失败，不再依赖故障镜像修补或跳过。
sudo dpkg -i "$deb"
verify_install
