#ifndef LITCH_BROWSER_KEYCHAIN_H
#define LITCH_BROWSER_KEYCHAIN_H
#include <stddef.h>
#include <stdint.h>

typedef struct {
  int32_t status;
  size_t length;
  unsigned char* bytes;
} LitchSecret;

// 只有固定浏览器白名单，不接收任意服务名、账户或查询字典。
LitchSecret litch_read_safe_storage(const char* browser);
#endif
