#!/bin/bash
# 使用已构建的 Linux 适配器与已下载的 CFT，在两个无外网的容器中验收。
set -eu
if [ "$#" -ne 4 ]; then
  printf '%s\n' "用法：bash $0 <本地容器镜像 ID> <CFT zip> <Linux 适配器> <Linux Codex>" >&2
  exit 2
fi
fixture_image="$1"
fixture_chrome="$2"
fixture_adapter="$3"
fixture_codex="$4"
fixture_net="litch-remote-chrome-$$"
fixture_ctrl="$fixture_net-controller"
fixture_device="$fixture_net-device"
docker network create --internal "$fixture_net" >/dev/null
cleanup() {
  docker stop "$fixture_device" "$fixture_ctrl" >/dev/null 2>&1 || true
  docker rm "$fixture_ctrl" >/dev/null 2>&1 || true
  docker network rm "$fixture_net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

run_fixture() {
  local role="$1"
  shift
  docker run "$@" --network "$fixture_net" --tmpfs /tmp/.X11-unix:rw,mode=1777 \
    -v "$fixture_chrome":/fixture/cft.zip:ro \
    -v "$fixture_adapter":/fixture/litch:ro \
    -v "$fixture_codex":/fixture/codex:ro \
    -v "$PWD":/repo:ro --entrypoint sh "$fixture_image" -c '
      set -eu
      export HOME="$(mktemp -d /tmp/litch-chrome-fixture-XXXXXX)"
      export XDG_CONFIG_HOME="$HOME/.config" XDG_CACHE_HOME="$HOME/.cache"
      export CODEX_HOME="$HOME/codex" CLAUDE_CONFIG_DIR="$HOME/claude"
      export LITCH_ADAPTER_BINARY=/fixture/litch LITCH_FIXTURE_CODEX=/fixture/codex
      unset DISPLAY WAYLAND_DISPLAY
      unzip -q /fixture/cft.zip -d "$HOME"
      LITCH_CHROME_BINARY="$(find "$HOME" -maxdepth 2 -name chrome -type f -print -quit)"
      export LITCH_CHROME_BINARY
      exec node /repo/scripts/chrome-e2e/remote-device.mjs "$1"
    ' fixture "$role"
}

run_fixture controller -d --name "$fixture_ctrl" --network-alias fixture-controller >/dev/null
for ((try=0; try<120; ++try)); do
  if docker logs "$fixture_ctrl" 2>&1 | grep -q CONTROLLER_READY; then
    docker logs "$fixture_ctrl" 2>&1 | grep -E '^(controller|CONTROLLER_READY)'
    fixture_socket="$(docker exec --user 0 "$fixture_ctrl" sh -c 'find /tmp -maxdepth 2 -type s -path "/tmp/litch-device-chrome-*/native.sock" -print -quit')"
    test -n "$fixture_socket"
    docker exec --user 65534 "$fixture_ctrl" node -e '
      const socket = require("node:net").connect(process.argv[1])
      socket.on("error", (error) => {
        if (error.code !== "EACCES") process.exitCode = 1
        else console.log("CHROME_OTHER_UID_DENIED")
      })
      socket.on("connect", () => { socket.destroy(); process.exitCode = 1 })
    ' "$fixture_socket"
    run_fixture sessionDevice --rm --name "$fixture_device"
    exit
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$fixture_ctrl")" != true ]; then break; fi
  sleep .2
done
docker logs "$fixture_ctrl"
exit 1
