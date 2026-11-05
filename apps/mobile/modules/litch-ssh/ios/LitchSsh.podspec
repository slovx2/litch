require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'LitchSsh'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.author = 'Litch'
  s.homepage = 'https://github.com/slovx2/litch'
  s.source = { :git => 'https://github.com/slovx2/litch.git' }
  s.platform = :ios, '16.4'
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore', '57.0.23'
  s.source_files = '*.swift'
  s.vendored_frameworks = 'generated/Sshtransport.xcframework'
  # 静态 XCFramework 的资源不会自动复制到 App，另打资源包供归档隐私报告与许可分发。
  s.resource_bundles = { 'LitchSshPrivacy' => ['PrivacyInfo.xcprivacy', 'generated/resources/go-third-party.txt'] }
  s.frameworks = 'Security', 'SystemConfiguration', 'Network', 'CoreFoundation'
end
