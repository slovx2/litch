# 使用 CocoaPods 自带的固定版本 xcodeproj 生成独立 UI 测试目标，不改 Expo 工程。
gem 'xcodeproj', '1.28.1'
require 'xcodeproj'

directory, source, config = ARGV
project = Xcodeproj::Project.new(File.join(directory, 'TerminalTests.xcodeproj'))
target = project.new_target(:ui_test_bundle, 'TerminalTests', :ios, '16.4')
target.source_build_phase.add_file_reference(project.main_group.new_file(source))
support = File.expand_path('../e2e/ios/ConsentTestSupport.swift', __dir__)
target.source_build_phase.add_file_reference(project.main_group.new_file(support))
target.resources_build_phase.add_file_reference(project.main_group.new_file(config))
target.build_configurations.each do |configuration|
  configuration.build_settings.merge!(
    'PRODUCT_BUNDLE_IDENTIFIER' => 'dev.litch.terminaltests',
    'SWIFT_VERSION' => '5.9',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'CODE_SIGNING_ALLOWED' => 'NO'
  )
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.add_test_target(target)
scheme.save_as(project.path, 'TerminalTests', true)
