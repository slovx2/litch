#!/bin/bash
# 先编 Go，再生成 Expo 工程；不签名的模拟器包可用 LITCH_IOS_DESTINATION 指定目标。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
npm run web:build
bash "$SCRIPT_DIR/build-ssh-ios.sh"
npx expo prebuild --platform ios --no-install
pod install --project-directory=ios
SCHEME=Litch
if [[ "${LITCH_MOBILE_DEV:-0}" == 1 ]]; then SCHEME=LitchDev; fi
xcodebuild -workspace "ios/$SCHEME.xcworkspace" -scheme "$SCHEME" \
  -configuration Release -destination "${LITCH_IOS_DESTINATION:-generic/platform=iOS Simulator}" \
  -derivedDataPath ios/build ARCHS=arm64 CODE_SIGNING_ALLOWED=NO build
