#!/bin/bash
# 在 pod install 前生成真机和 Apple Silicon 模拟器共用的 Go 桥；版本来自 mobile/go.mod。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUTPUT_DIR="$REPO_DIR/apps/mobile/modules/litch-ssh/ios/generated"
mkdir -p "$OUTPUT_DIR"
cd "$REPO_DIR/mobile"
export GOTOOLCHAIN="go$(awk '$1 == "go" { print $2; exit }' go.mod)"
export PATH="$(go env GOPATH)/bin:$PATH"
go run golang.org/x/mobile/cmd/gomobile init
go run golang.org/x/mobile/cmd/gomobile bind \
  -target=ios/arm64,iossimulator/arm64 -iosversion=16.4 \
  -o "$OUTPUT_DIR/Sshtransport.xcframework" ./sshtransport
node "$REPO_DIR/mobile/licenses.mjs" "$OUTPUT_DIR/resources/go-third-party.txt"
for SLICE in ios-arm64 ios-arm64-simulator; do
  cp "$OUTPUT_DIR/../PrivacyInfo.xcprivacy" "$OUTPUT_DIR/Sshtransport.xcframework/$SLICE/Sshtransport.framework/PrivacyInfo.xcprivacy"
done
