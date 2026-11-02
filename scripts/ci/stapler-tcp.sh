#!/bin/bash
# 仅 ARM 托管 runner 的票据命令使用；两台 runner 对照后启用，保留有界重试。
# https://github.com/actions/runner-images/issues/14924
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]]
[[ "$#" == 2 && ( "$1" == staple || "$1" == validate ) ]]
anchor="com.apple/litch-stapler-${GITHUB_RUN_ID:?}-$$"
token=''
child=''
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "$child" ]]; then kill "$child" 2>/dev/null || true; fi
  sudo pfctl -a "$anchor" -F rules || { echo 'LITCH_PF_CLEANUP_FAILED' >&2; result=1; }
  if [[ -n "$token" ]]; then
    sudo pfctl -X "$token" || { echo 'LITCH_PF_CLEANUP_FAILED' >&2; result=1; }
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# macOS 默认规则已包含此通配 anchor；缺失时直接停，不改写全局规则。
sudo pfctl -sr | grep -E '^anchor "com\.apple/\*"'
printf '%s\n' 'block return out quick proto udp from any to any port 443' | sudo pfctl -a "$anchor" -f -
enabled="$(sudo pfctl -E 2>&1)"
token="$(printf '%s\n' "$enabled" | sed -nE 's/.*Token *: *([0-9]+).*/\1/p')"
[[ "$token" =~ ^[0-9]+$ ]]
sudo pfctl -a "$anchor" -sr
xcrun stapler "$1" "$2" &
child=$!
result=0
wait "$child" || result=$?
child=''
exit "$result"
