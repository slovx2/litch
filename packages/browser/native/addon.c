#include "keychain.h"
#include <node_api.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>
#include <string.h>

static napi_value read_secret(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument, result, status, bytes;
  char browser[32] = {0};
  size_t length = 0;
  LitchSecret secret = { .status = -50 };
  if (napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) == napi_ok && argc == 1 &&
      napi_get_value_string_utf8(env, argument, browser, sizeof(browser), &length) == napi_ok &&
      length > 0 && length < sizeof(browser) - 1 && strlen(browser) == length) {
    secret = litch_read_safe_storage(browser);
  }
  napi_status code = napi_create_object(env, &result);
  if (code == napi_ok) code = napi_create_int32(env, secret.status, &status);
  if (code == napi_ok) code = napi_set_named_property(env, result, "status", status);
  if (code == napi_ok && secret.status == 0) {
    code = napi_create_buffer_copy(env, secret.length, secret.bytes, NULL, &bytes);
    if (code == napi_ok) code = napi_set_named_property(env, result, "bytes", bytes);
  }
  if (secret.bytes) {
    // volatile 写入不能被优化器作为无用写操作移除。
    volatile unsigned char* bytes_to_clear = secret.bytes;
    for (size_t i = 0; i < secret.length; i++) bytes_to_clear[i] = 0;
    free(secret.bytes);
  }
  if (code != napi_ok) {
    napi_throw_error(env, NULL, "Keychain bridge failed.");
    return NULL;
  }
  return result;
}

static void bundle_string(napi_env env, napi_value object, CFBundleRef bundle, CFStringRef key, const char* property) {
  CFTypeRef value = bundle ? CFBundleGetValueForInfoDictionaryKey(bundle, key) : NULL;
  char text[512] = {0};
  if (value && CFGetTypeID(value) == CFStringGetTypeID()) {
    CFStringGetCString((CFStringRef)value, text, sizeof(text), kCFStringEncodingUTF8);
  }
  napi_value output;
  if (napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &output) == napi_ok) {
    napi_set_named_property(env, object, property, output);
  }
}

// 无钥匙串访问的诊断，验收时核对实际承载原生代码的应用归属。
static napi_value identity(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok) return NULL;
  CFBundleRef bundle = CFBundleGetMainBundle();
  bundle_string(env, result, bundle, kCFBundleNameKey, "name");
  bundle_string(env, result, bundle, kCFBundleIdentifierKey, "identifier");
  return result;
}

NAPI_MODULE_INIT() {
  const napi_property_descriptor methods[] = {
    { "read", NULL, read_secret, NULL, NULL, NULL, napi_default, NULL },
    { "identity", NULL, identity, NULL, NULL, NULL, napi_default, NULL },
  };
  if (napi_define_properties(env, exports, 2, methods) != napi_ok) return NULL;
  return exports;
}
