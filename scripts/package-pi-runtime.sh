#!/bin/sh
# 默认只构建 versions 固定的干净提交；本地验收必须显式声明。
# 制品只含适配器与随附插件；Node 24 与 Pi 均来自宿主独立安装，版本由 versions 校验。
set -eu
adapter_source=${1:?需要适配器源码目录}
artifact_dir=${2:?需要制品输出目录}
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
adapter_source=$(CDPATH= cd -- "$adapter_source" && pwd)
mkdir -p "$artifact_dir"
artifact_dir=$(CDPATH= cd -- "$artifact_dir" && pwd)
actual_commit=$(git -C "$adapter_source" rev-parse HEAD)
build_kind=release
case "${3:-}" in
  --local-acceptance) build_kind=local-acceptance ;;
  '')
    test -z "$(git -C "$adapter_source" status --porcelain)" || { echo '适配器构建源存在未提交修改' >&2; exit 1; }
    ;;
  *) echo '未知构建选项' >&2; exit 1 ;;
esac
# 制品不再附带 Node：运行时使用宿主 PATH 中的 Node 24。
test "$(node -p 'process.versions.node.split(".")[0]')" = 24 || { echo '必须使用 Node 24' >&2; exit 1; }
node_dir=$(dirname "$(command -v node)")
test "$(uname -s)-$(uname -m)" = 'Linux-x86_64'
command -v go >/dev/null 2>&1 || { echo '需要 Go：终端用的伪终端桥在适配器的命令行里，要现编一份放进制品' >&2; exit 1; }
npm ci --prefix "$adapter_source" --no-audit --no-fund
npm ci --prefix "$adapter_source/packages/pi" --no-audit --no-fund
npm run build --prefix "$adapter_source/packages/pi"
# 开发依赖里的 Pi 本体只用于类型与测试，不进入制品。
npm prune --omit=dev --prefix "$adapter_source/packages/pi" --no-audit --no-fund
stage=$(mktemp -d)
trap 'rm -r -- "$stage"' EXIT HUP INT TERM
runtime="$stage/pi-runtime"
mkdir -p "$runtime/bin" "$stage/home"
cp "$adapter_source/THIRD_PARTY_NOTICES.md" "$runtime/THIRD_PARTY_NOTICES.md"
cp -R "$adapter_source/packages/pi/dist" "$adapter_source/packages/pi/node_modules" "$runtime/lib/"
# prune 会留下空的作用域目录，按内容判断。
test -z "$(ls -A "$runtime/lib/node_modules/@earendil-works" 2>/dev/null)" || { echo '制品不应包含 Pi 本体' >&2; exit 1; }
cp "$adapter_source/packages/pi/package.json" "$adapter_source/packages/pi/package-lock.json" "$runtime/lib/"
cp "$adapter_source/LICENSE" "$runtime/"
cp "$project_root/protocol/versions.json" "$runtime/versions.json"
cp "$adapter_source/packages/pi/README.md" "$runtime/README.md"
# PTY 终端由适配器命令行（Go）的 pty-bridge 子命令来起，适配器从 lib/dist 往上找到 bin/ 里的这一份。
# 关掉 cgo 静态编译，不挑宿主的 C 库；宿主上不再需要 python3。
(cd "$adapter_source" && CGO_ENABLED=0 go build -trimpath -o "$runtime/bin/codex-harness-adapter" ./cmd/codex-harness-adapter)
cat > "$runtime/bin/codex-harness-adapter-pi" <<'WRAPPER'
#!/bin/sh
set -eu
runtime_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$runtime_root/lib/dist/pi/src/adapter.mjs" "$@"
WRAPPER
chmod 0755 "$runtime/bin/codex-harness-adapter-pi"
# 构建验收使用隔离安装的真实固定 Pi，不把它复制进制品，不修改宿主全局安装。
cli_version=$(node -e 'console.log(require(process.argv[1]).piCli)' "$project_root/protocol/versions.json")
npm install --prefix "$stage/host-cli" --save-exact "@earendil-works/pi-coding-agent@$cli_version" --no-audit --no-fund
host_cli="$stage/host-cli/node_modules/.bin/pi"
env -i PATH="$node_dir:/usr/bin:/bin" HOME="$stage/home" PI_CLI="$host_cli" \
  "$runtime/bin/codex-harness-adapter-pi" --runtime-info > "$runtime/build.json"
env -i PATH="$node_dir:/usr/bin:/bin" HOME="$stage/home" "$runtime/bin/codex-harness-adapter-pi" --pty-self-check
test ! -d "$runtime/lib/node_modules/@anthropic-ai/claude-agent-sdk"
node --input-type=module - "$runtime" "$adapter_source" "$build_kind" "$actual_commit" <<'JS'
import {readFileSync,writeFileSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
const root=process.argv[2]
const source=process.argv[3]
const info=JSON.parse(readFileSync(`${root}/build.json`))
const pin=JSON.parse(readFileSync(`${root}/versions.json`))
if(info.engine!=='pi' || info.nodeVersion.split('.')[0]!==pin.node || info.protocolVersion!==pin.codexProtocol ||
   info.sdkVersion!==pin.piCodingAgent || info.cliBuild!==pin.piCli ||
   info.pluginVersions['@narumitw/pi-plan-mode']!==pin.piPlanMode ||
   info.pluginVersions['@narumitw/pi-tui-kit']!==pin.piTuiKit ||
   info.pluginVersions['@gotgenes/pi-subagents']!==pin.piSubagents)
  throw Error('Pi 制品版本不符合 versions')
info.lockSha256=createHash('sha256').update(readFileSync(`${root}/lib/package-lock.json`)).digest('hex')
info.target='linux-amd64'
info.artifactKind=process.argv[4]
info.adapterCommit=process.argv[5]
info.cliSource='host'
const hash=createHash('sha256')
for(const directory of ['packages/pi/src','packages/shared/src']) {
  for(const file of readdirSync(`${source}/${directory}`).filter(name=>name.endsWith('.mts')).sort()) {
    hash.update(`${directory}/${file}\0`);hash.update(readFileSync(`${source}/${directory}/${file}`))
  }
}
info.sourceSha256=hash.digest('hex')
writeFileSync(`${root}/build.json`,JSON.stringify(info,null,2)+'\n')
JS
asset="codex-harness-adapter-pi_${actual_commit}_linux_amd64.tar.gz"
if [ "$build_kind" = local-acceptance ]; then asset="codex-harness-adapter-pi_${actual_commit}_local_linux_amd64.tar.gz"; fi
tar -C "$stage" -czf "$artifact_dir/$asset" pi-runtime
(cd "$artifact_dir" && sha256sum "$asset" > "$asset.sha256")
mkdir "$stage/unpacked"
tar -C "$stage/unpacked" -xzf "$artifact_dir/$asset"
env -i PATH="$node_dir:/usr/bin:/bin" HOME="$stage/home" PI_CLI="$host_cli" \
  "$stage/unpacked/pi-runtime/bin/codex-harness-adapter-pi" --runtime-info
env -i PATH="$node_dir:/usr/bin:/bin" HOME="$stage/home" "$stage/unpacked/pi-runtime/bin/codex-harness-adapter-pi" --pty-self-check
PI_CLI="$host_cli" node "$adapter_source/packages/pi/test/artifact-smoke.mjs" "$stage/unpacked/pi-runtime"
echo "$artifact_dir/$asset"
