#!/usr/bin/env bash
# 出给集成方（WakeQora）的 Claude 入口包 cha-v<版本>.tar.gz，和它的校验和清单 cha-SHA256SUMS.txt。
#
# 包里只有 packages/claude 的编译输出（含 linux-amd64、linux-arm64 两份守护进程）、按它的 package-lock.json
# 装的运行依赖（不含 optional 依赖里 Agent SDK 自带的各平台 CLI，CLI 由集成方自己装），以及记版本的
# cha-build.json。集成方按发布页上这个附件的 URL 下载，对照自己锁文件里的 sha256 校验。
#
# 构建在钉了摘要的 Go、Node 镜像里进行，源码取自 `git archive <提交>`（不含工作区未提交的改动），
# 打包时去掉时间戳和属主：同一个提交在哪台机器上出都是同一个 sha256，集成方可以自己重出一份核对。
# 镜像、步骤和 WakeQora 的 packaging/cha/build-cha-artifact.sh 一致，改这里要同时告诉集成方。
#
# 用法：
#   bash scripts/package-cha.sh --out <目录> [--ref <提交或标签>]
#
#   --out  产物目录
#   --ref  出包用的提交，默认 HEAD；版本号取这个提交的 package.json

set -euo pipefail

NODE_IMAGE="node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03"
# 守护进程（cmd/claude-process-guard）用的 Go，要和 go.mod 写的版本一样
GO_VERSION="1.26.10"
GO_IMAGE="golang:${GO_VERSION}-bookworm@sha256:632dff7351799a5a9954a48dc06670ade72ee44e8c351cdc0e5a57af2fea21af"
# 包只给 Linux 用：守护进程只编这两个平台
GUARD_TARGETS="linux-amd64 linux-arm64"

log() { printf '[package-cha] %s\n' "$*"; }
fail() { printf '[package-cha] 错误：%s\n' "$*" >&2; exit 1; }

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
out_dir=""
ref="HEAD"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) [ "$#" -ge 2 ] || fail "--out 缺少值"; out_dir="$2"; shift 2 ;;
    --ref) [ "$#" -ge 2 ] || fail "--ref 缺少值"; ref="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) fail "未知参数：$1" ;;
  esac
done

[ -n "$out_dir" ] || fail "需要 --out <目录>"
command -v docker >/dev/null 2>&1 || fail "缺少 docker"

commit="$(git -C "$repo_root" rev-parse --verify "${ref}^{commit}")"
version="v$(git -C "$repo_root" show "$commit:package.json" | sed -n 's/^  "version": "\(.*\)",$/\1/p')"
[ "$version" != "v" ] || fail "$commit 的 package.json 里读不到版本号"
go_mod="$(git -C "$repo_root" show "$commit:go.mod" | sed -n 's/^go //p')"
[ "$go_mod" = "$GO_VERSION" ] || fail "go.mod 要的 Go 是 $go_mod，本脚本的镜像是 $GO_VERSION，先把 GO_IMAGE 换成对应版本"

mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/litch-cha-XXXXXX")"
cleanup() { [ -z "${work:-}" ] || rm -rf "${work:?}"; }
trap cleanup EXIT

log "导出 $commit（$version）"
git -C "$repo_root" archive --format=tar -o "$work/source.tar" "$commit"
cat > "$work/guard.sh" <<'SH'
set -euo pipefail
mkdir -p /tmp/src
tar -xf /work/source.tar -C /tmp/src
cd /tmp/src
for target in $GUARD_TARGETS; do
  out="/work/guard/$target/claude-process-guard"
  GOOS="${target%-*}" GOARCH="${target#*-}" CGO_ENABLED=0 \
    go build -trimpath -buildvcs=false -ldflags='-s -w' -o "$out" ./cmd/claude-process-guard
  chmod 0755 "$out"
done
SH
cat > "$work/build.sh" <<'SH'
set -euo pipefail
mkdir -p /build/src /build/stage
tar -xf /work/source.tar -C /build/src
cd /build/src
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
npm ci --prefix packages/claude --ignore-scripts --no-audit --no-fund >/dev/null
package=/build/src/packages/claude
# 只编 TypeScript；守护进程用上一步在 Go 镜像里编好的（包里的 build 脚本会现场调 go）
(cd "$package" && npx --no-install tsc -p tsconfig.json)
mkdir -p "$package/dist/claude/src/process-guard"
cp -R /work/guard/. "$package/dist/claude/src/process-guard/"
cp "$package/package.json" "$package/package-lock.json" /build/stage/
for part in claude shared protocol; do
  mkdir -p "/build/stage/dist/$part"
  cp -R "$package/dist/$part/src" "/build/stage/dist/$part/src"
done
cd /build/stage
npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund >/dev/null
node -e '
const sdk = require("/build/stage/node_modules/@anthropic-ai/claude-agent-sdk/package.json")
const info = {
  litchVersion: process.argv[1],
  litchCommit: process.argv[2],
  agentSdkVersion: sdk.version,
  claudeCodeVersion: sdk.claudeCodeVersion,
}
require("fs").writeFileSync("/build/stage/cha-build.json", JSON.stringify(info, null, 2) + "\n")
' "$VERSION" "$COMMIT"
tar --sort=name --mtime="1970-01-01 00:00:00Z" --owner=0 --group=0 --numeric-owner \
  --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
  -C /build/stage -cf - . | gzip -n -9 > "/work/$ARTIFACT"
SH

artifact="cha-${version}.tar.gz"
log "在 $GO_IMAGE 里编守护进程（$GUARD_TARGETS）"
# 用当前用户跑，产物不归 root，清理临时目录不受影响；Go 的缓存放容器里的 /tmp
docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e GOCACHE=/tmp/go-cache -e GOMODCACHE=/tmp/go-mod -e GOTOOLCHAIN=local \
  -e GOFLAGS=-mod=readonly -e GUARD_TARGETS="$GUARD_TARGETS" \
  -v "$work:/work" \
  "$GO_IMAGE" bash /work/guard.sh
log "在 $NODE_IMAGE 里构建"
docker run --rm \
  -e VERSION="$version" -e COMMIT="$commit" -e ARTIFACT="$artifact" -e NPM_CONFIG_UPDATE_NOTIFIER=false \
  -v "$work:/work" \
  "$NODE_IMAGE" bash /work/build.sh

mv "$work/$artifact" "$out_dir/$artifact"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$out_dir" && sha256sum "$artifact" > cha-SHA256SUMS.txt)
else
  (cd "$out_dir" && shasum -a 256 "$artifact" > cha-SHA256SUMS.txt)
fi
log "完成：$out_dir/$artifact"
cat "$out_dir/cha-SHA256SUMS.txt"
