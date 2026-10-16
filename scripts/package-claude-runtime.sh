#!/bin/sh
# 保留固定 SDK；Node 24 与 Claude CLI 均来自宿主独立安装，版本由 versions 校验。
set -eu
adapter_source=${1:?需要适配器仓库目录}
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
test "$(node -p 'process.versions.node.split(".")[0]')" = 24 || { echo '必须使用 Node 24' >&2; exit 1; }
node_dir=$(dirname "$(command -v node)")
test "$(uname -s)" = 'Linux' || { echo '本制品必须在 Linux 构建' >&2; exit 1; }
test "$(uname -m)" = 'x86_64' || { echo '本制品必须在 amd64 构建' >&2; exit 1; }
command -v go >/dev/null 2>&1 || { echo '需要 Go：终端用的伪终端桥在适配器的命令行里，要现编一份放进制品' >&2; exit 1; }
npm ci --prefix "$adapter_source"
npm ci --prefix "$adapter_source/packages/claude"
npm run build --prefix "$adapter_source/packages/claude"
npm prune --omit=dev --omit=optional --prefix "$adapter_source/packages/claude"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir -p "$stage/claude-runtime/bin" "$stage/home"
cp "$adapter_source/THIRD_PARTY_NOTICES.md" "$stage/claude-runtime/THIRD_PARTY_NOTICES.md"
cp -R "$adapter_source/packages/claude/dist" "$adapter_source/packages/claude/node_modules" "$stage/claude-runtime/lib/"
cp "$adapter_source/packages/claude/package.json" "$adapter_source/packages/claude/package-lock.json" "$adapter_source/LICENSE" "$stage/claude-runtime/lib/"
# PTY 终端由适配器命令行（Go）的 pty-bridge 子命令来起，适配器从 lib/dist 往上找到 bin/ 里的这一份。
# 关掉 cgo 静态编译，不挑宿主的 C 库；宿主上不再需要 python3。
(cd "$adapter_source" && CGO_ENABLED=0 go build -trimpath -o "$stage/claude-runtime/bin/codex-harness-adapter" ./cmd/codex-harness-adapter)
cp "$project_root/protocol/versions.json" "$stage/claude-runtime/versions.json"
cat > "$stage/claude-runtime/bin/codex-harness-adapter-claude" <<'WRAPPER'
#!/bin/sh
set -eu
runtime_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$runtime_root/lib/dist/claude/src/adapter.mjs" "$@"
WRAPPER
chmod 0755 "$stage/claude-runtime/bin/codex-harness-adapter-claude"
# 构建验收使用隔离安装的真实固定 CLI，不把它复制进制品，不修改宿主全局安装。
cli_version=$(node -e 'console.log(require(process.argv[1]).claudeCli)' "$project_root/protocol/versions.json")
npm install --prefix "$stage/host-cli" --save-exact "@anthropic-ai/claude-code@$cli_version" --no-audit --no-fund
host_cli="$stage/host-cli/node_modules/.bin/claude"
env -i PATH="$node_dir:/usr/bin:/bin" HOME="$stage/home" CLAUDE_CONFIG_DIR="$stage/home/claude" DISABLE_AUTOUPDATER=1 \
  CHA_CLAUDE_CLI="$host_cli" "$stage/claude-runtime/bin/codex-harness-adapter-claude" --runtime-info > "$stage/claude-runtime/build.json"
node --input-type=module - "$stage/claude-runtime" "$build_kind" "$adapter_source" <<'JS'
import {readFileSync,writeFileSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
const [root,kind,source]=process.argv.slice(2)
const build=JSON.parse(readFileSync(`${root}/build.json`))
const pin=JSON.parse(readFileSync(`${root}/versions.json`))
if(build.nodeVersion.split('.')[0]!==pin.node || build.sdkVersion!==pin.claudeAgentSdk ||
   build.protocolVersion!==pin.codexProtocol || build.cliBuild!==`${pin.claudeCli} (Claude Code)` ||
   !build.cliSha256) throw Error('Claude 制品版本不符合 versions')
const assertNoNative=(dir)=>{
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
    if(entry.name.startsWith('claude-agent-sdk-')) throw Error(`制品不应包含原生 SDK 包: ${entry.name}`)
    if(entry.isDirectory()) assertNoNative(`${dir}/${entry.name}`)
  }
}
assertNoNative(`${root}/lib/node_modules`)
const hash=createHash('sha256')
const hashSources=(dir)=>{
  for(const entry of readdirSync(`${source}/${dir}`,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    const path=`${dir}/${entry.name}`
    if(entry.isDirectory()) hashSources(path)
    else { hash.update(`${path}\0`);hash.update(readFileSync(`${source}/${path}`)) }
  }
}
hashSources('packages/claude/src');hashSources('packages/shared/src')
build.sourceSha256=hash.digest('hex')
build.artifactKind=kind
build.cliSource='host'
writeFileSync(`${root}/build.json`,JSON.stringify(build,null,2)+'\n')
JS
env -i PATH="$node_dir:/usr/bin:/bin" HOME="$stage/home" "$stage/claude-runtime/bin/codex-harness-adapter-claude" --pty-self-check
asset="codex-harness-adapter-claude_${actual_commit}_linux_amd64.tar.gz"
if [ "$build_kind" = local-acceptance ]; then asset="codex-harness-adapter-claude_${actual_commit}_local_linux_amd64.tar.gz"; fi
tar -C "$stage" -czf "$artifact_dir/$asset" claude-runtime
(cd "$artifact_dir" && sha256sum "$asset" > "$asset.sha256")
mkdir "$stage/unpacked"
tar -C "$stage/unpacked" -xzf "$artifact_dir/$asset"
unpacked="$stage/unpacked/claude-runtime"
env -i PATH="$node_dir:/usr/bin:/bin" HOME="$stage/home" CLAUDE_CONFIG_DIR="$stage/home/claude" DISABLE_AUTOUPDATER=1 \
  CHA_CLAUDE_CLI="$host_cli" "$unpacked/bin/codex-harness-adapter-claude" --runtime-info
env -i PATH="$node_dir:/usr/bin:/bin" HOME="$stage/home" "$unpacked/bin/codex-harness-adapter-claude" --pty-self-check
(cd "$unpacked/lib" && env -i PATH="$unpacked/bin:$node_dir:/usr/bin:/bin" HOME="$stage/home" \
  CODEX_SCHEMA_DIR="$project_root/protocol/codex-app-server/0.157.1/json-schema" \
  CHA_CLAUDE_CLI="$host_cli" node --test \
  dist/claude/test/native-image-reference.test.mjs dist/claude/test/mcp-user-config.test.mjs)
echo 'ARTIFACT PASS: 无原生 SDK 平台包，宿主 CLI 身份、解包启动、PTY、真实 SDK mock 回合'
echo "$asset"
