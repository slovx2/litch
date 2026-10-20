// 原生桥的测试查询：不调用 Security.framework、不读取真实钥匙串。
#include "keychain.h"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

LitchSecret litch_read_safe_storage(const char* browser) {
  if (strcmp(browser, "chrome") == 0) {
    const unsigned char fixture[] = { ' ', 'k', 0, 'y', '\n' };
    LitchSecret result = { .length = sizeof(fixture), .bytes = malloc(sizeof(fixture)) };
    if (!result.bytes) return (LitchSecret){ .status = -108 };
    memcpy(result.bytes, fixture, sizeof(fixture));
    return result;
  }
  if (strcmp(browser, "edge") == 0) return (LitchSecret){ .status = -128 };
  if (strcmp(browser, "brave") == 0) return (LitchSecret){ .status = -25293 };
  if (strcmp(browser, "arc") == 0) return (LitchSecret){ .status = -25308 };
  if (strcmp(browser, "vivaldi") == 0) return (LitchSecret){ .status = -25300 };
  if (strcmp(browser, "chromium") == 0) sleep(30);
  return (LitchSecret){ .status = -4 };
}
