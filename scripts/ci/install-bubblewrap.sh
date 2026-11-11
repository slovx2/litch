#!/usr/bin/env bash
# Ubuntu 24.04 amd64 的固定沙箱依赖；apt 镜像故障时使用 Ubuntu 官方安全仓库的同一包。
set -euo pipefail

version=0.9.0-1ubuntu0.3
sha256=2461f1beee9cb04c8942739fe1a2b37e7b7c2a3d518f0779dc75f9245baa3094
# SHA256 来源：https://packages.ubuntu.com/noble/amd64/bubblewrap/download
url=https://security.ubuntu.com/ubuntu/pool/main/b/bubblewrap/bubblewrap_0.9.0-1ubuntu0.3_amd64.deb

if [ "$(dpkg --print-architecture)" != amd64 ]; then
  echo 'bubblewrap 安装仅支持当前 CI 使用的 Ubuntu amd64 runner' >&2
  exit 1
fi

verify_install() {
  local installed
  installed=$(dpkg-query -W -f='${Status} ${Version}' bubblewrap)
  if [ "$installed" != "install ok installed $version" ]; then
    echo "bubblewrap 安装状态或版本不符：$installed" >&2
    return 1
  fi
  bwrap --version
}

# Error-Mode=any 防止 update 在部分镜像 DNS 失败时仍返回成功；总时限包含 apt 自身重试。
if sudo timeout 120s apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=15 \
    -o Acquire::https::Timeout=15 -o APT::Update::Error-Mode=any update &&
  sudo timeout 120s apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=15 \
    -o Acquire::https::Timeout=15 install --yes --no-install-recommends "bubblewrap=$version"; then
  verify_install
  exit 0
fi

echo 'apt 安装失败；改从 Ubuntu 官方安全仓库下载同版本 bubblewrap，并校验固定 SHA256' >&2
work=$(mktemp -d)
trap 'rm -rf -- "${work:?}"' EXIT
deb="$work/bubblewrap.deb"
curl --fail --location --silent --show-error --retry 2 --connect-timeout 15 --max-time 60 \
  --proto '=https' --proto-redir '=https' --output "$deb" "$url"
printf '%s  %s\n' "$sha256" "$deb" | sha256sum --check --strict -
if [ "$(dpkg --field "$deb" Package)" != bubblewrap ] ||
  [ "$(dpkg --field "$deb" Version)" != "$version" ] ||
  [ "$(dpkg --field "$deb" Architecture)" != amd64 ]; then
  echo '下载的 bubblewrap 包名称、版本或架构不符，拒绝安装' >&2
  exit 1
fi
# runner 已提供 libc6/libcap2/libselinux1；缺依赖时 dpkg 失败，不再依赖故障镜像修补或跳过。
sudo dpkg -i "$deb"
verify_install
