# 独立签名测试宿主，只编入生产原生桥与同一份 XCFramework；不修改 Expo 项目。
gem 'xcodeproj', '1.28.1'
require 'xcodeproj'

directory, mobile, config = ARGV
native = File.join(mobile, 'modules/litch-ssh/ios')
project = Xcodeproj::Project.new(File.join(directory, 'NetworkTests.xcodeproj'))
host = project.new_target(:application, 'NetworkHost', :ios, '16.4')
host.source_build_phase.add_file_reference(project.main_group.new_file(File.join(directory, 'Host.swift')))
target = project.new_target(:unit_test_bundle, 'NetworkTests', :ios, '16.4')
target.add_dependency(host)
['TailscaleStorage.swift', 'TailscaleRuntime.swift'].each do |source|
  target.source_build_phase.add_file_reference(project.main_group.new_file(File.join(native, source)))
end
target.source_build_phase.add_file_reference(project.main_group.new_file(File.join(mobile, 'e2e/ios/TailscaleNativeTests.swift')))
target.resources_build_phase.add_file_reference(project.main_group.new_file(config))
framework = File.join(native, 'generated/Sshtransport.xcframework/ios-arm64-simulator')
target.frameworks_build_phase.add_file_reference(project.main_group.new_file(File.join(framework, 'Sshtransport.framework')))
target.add_system_framework('Security')
target.add_system_framework('SystemConfiguration')
target.add_system_framework('Network')
[host, target].each do |item|
  item.build_configurations.each do |configuration|
    configuration.build_settings.merge!(
      'PRODUCT_BUNDLE_IDENTIFIER' => "dev.litch.#{item.name.downcase}",
      'SWIFT_VERSION' => '5.9', 'GENERATE_INFOPLIST_FILE' => 'YES',
      'CODE_SIGNING_ALLOWED' => 'YES', 'CODE_SIGN_IDENTITY' => '-', 'DEVELOPMENT_TEAM' => '',
      'CODE_SIGN_ENTITLEMENTS' => File.join(directory, 'Host.entitlements'),
      'FRAMEWORK_SEARCH_PATHS' => ['$(inherited)', framework],
      'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks', '@loader_path/Frameworks']
    )
  end
end
target.build_configurations.each do |configuration|
  configuration.build_settings['TEST_HOST'] = '$(BUILT_PRODUCTS_DIR)/NetworkHost.app/NetworkHost'
  configuration.build_settings['BUNDLE_LOADER'] = '$(TEST_HOST)'
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(host)
scheme.add_test_target(target)
scheme.save_as(project.path, 'NetworkTests', true)
