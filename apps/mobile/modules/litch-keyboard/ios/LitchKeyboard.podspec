require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'LitchKeyboard'
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
end
