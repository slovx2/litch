#include "keychain.h"
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdlib.h>
#include <string.h>

LitchSecret litch_read_safe_storage(const char* browser) {
  static const struct { const char* browser; const char* service; } services[] = {
    { "chrome", "Chrome Safe Storage" },
    { "edge", "Microsoft Edge Safe Storage" },
    { "brave", "Brave Safe Storage" },
    { "arc", "Arc Safe Storage" },
    { "chromium", "Chromium Safe Storage" },
    { "vivaldi", "Vivaldi Safe Storage" },
  };
  const char* service = NULL;
  for (size_t i = 0; i < sizeof(services) / sizeof(services[0]); i++) {
    if (strcmp(browser, services[i].browser) == 0) service = services[i].service;
  }
  if (!service) return (LitchSecret){ .status = errSecUnimplemented };

  CFStringRef name = CFStringCreateWithCString(NULL, service, kCFStringEncodingUTF8);
  if (!name) return (LitchSecret){ .status = errSecAllocate };
  const void* keys[] = { kSecClass, kSecAttrService, kSecReturnData, kSecMatchLimit };
  const void* values[] = { kSecClassGenericPassword, name, kCFBooleanTrue, kSecMatchLimitOne };
  CFDictionaryRef query = CFDictionaryCreate(NULL, keys, values, 4,
    &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFRelease(name);
  if (!query) return (LitchSecret){ .status = errSecAllocate };
  CFTypeRef data = NULL;
  // 保留系统默认授权行为，不改 ACL、不关闭交互、不创建或更新钥匙串条目。
  OSStatus status = SecItemCopyMatching(query, &data);
  CFRelease(query);
  LitchSecret result = { .status = status };
  if (status == errSecSuccess) {
    if (!data || CFGetTypeID(data) != CFDataGetTypeID()) result.status = errSecDecode;
    else {
      CFIndex length = CFDataGetLength((CFDataRef)data);
      if (length <= 0 || length > 65536) result.status = errSecDecode;
      else {
        result.bytes = malloc((size_t)length);
        if (!result.bytes) result.status = errSecAllocate;
        else {
          result.length = (size_t)length;
          memcpy(result.bytes, CFDataGetBytePtr((CFDataRef)data), result.length);
        }
      }
    }
  }
  if (data) CFRelease(data);
  return result;
}
