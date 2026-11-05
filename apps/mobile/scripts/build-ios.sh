#!/bin/bash
# 先编 Go，再生成 Expo 工程；模拟器验收用 ad-hoc 签名，Keychain 需要实际 entitlement。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# Release 模拟器验收包也需要测试入口，正式归档脚本明确拒绝此开关。
if [[ "${LITCH_MOBILE_DEV:-0}" == 1 ]]; then export EXPO_PUBLIC_LITCH_E2E=1; fi
npm run web:build
bash "$SCRIPT_DIR/build-ssh-ios.sh"
npx expo prebuild --platform ios --no-install
pod install --project-directory=ios
SCHEME=Litch
if [[ "${LITCH_MOBILE_DEV:-0}" == 1 ]]; then SCHEME=LitchDev; fi
# 模拟器签名不使用本机保存的开发者团队或证书；真机交付另走 Xcode 正式签名。
SIGNING=(CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=)
if [[ "${LITCH_IOS_UNSIGNED:-0}" == 1 ]]; then SIGNING=(CODE_SIGNING_ALLOWED=NO); fi
xcodebuild -workspace "ios/$SCHEME.xcworkspace" -scheme "$SCHEME" \
  -configuration Release -destination "${LITCH_IOS_DESTINATION:-generic/platform=iOS Simulator}" \
  -derivedDataPath ios/build ARCHS=arm64 "${SIGNING[@]}" build
