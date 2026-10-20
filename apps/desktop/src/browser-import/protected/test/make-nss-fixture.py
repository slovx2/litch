"""可选交叉验证：用已安装的 NSS 在空目录生成纯测试凭据；不访问任何浏览器资料。"""

import base64
import ctypes
import json
import sys
from pathlib import Path


class SECItem(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_uint),
        ("data", ctypes.POINTER(ctypes.c_ubyte)),
        ("len", ctypes.c_uint),
    ]


def make_fixture(library: str, directory: Path, aes: bool = False) -> None:
    if not directory.is_absolute() or any(directory.iterdir()):
        raise ValueError("Fixture requires a new, empty absolute directory")
    nss = ctypes.CDLL(library)
    nss.NSS_InitReadWrite.argtypes = [ctypes.c_char_p]
    nss.NSS_InitReadWrite.restype = ctypes.c_int
    nss.PK11_GetInternalKeySlot.restype = ctypes.c_void_p
    nss.PK11_InitPin.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
    nss.PK11_InitPin.restype = ctypes.c_int
    nss.PK11_FreeSlot.argtypes = [ctypes.c_void_p]
    if aes:
        encrypt_function = nss.PK11SDR_EncryptWithMechanism
        encrypt_function.argtypes = [ctypes.c_void_p, ctypes.POINTER(SECItem), ctypes.c_ulong,
            ctypes.POINTER(SECItem), ctypes.POINTER(SECItem), ctypes.c_void_p]
    else:
        encrypt_function = nss.PK11SDR_Encrypt
        encrypt_function.argtypes = [ctypes.POINTER(SECItem), ctypes.POINTER(SECItem),
            ctypes.POINTER(SECItem), ctypes.c_void_p]
    encrypt_function.restype = ctypes.c_int
    nss.SECITEM_ZfreeItem.argtypes = [ctypes.POINTER(SECItem), ctypes.c_int]
    nss.NSS_Shutdown.restype = ctypes.c_int
    if nss.NSS_InitReadWrite(f"sql:{directory}".encode()) != 0:
        raise RuntimeError("NSS initialization failed")
    slot = nss.PK11_GetInternalKeySlot()
    try:
        if not slot or nss.PK11_InitPin(slot, None, b"") != 0:
            raise RuntimeError("NSS test database initialization failed")

        def encrypt(value: bytes) -> str:
            buffer = (ctypes.c_ubyte * len(value)).from_buffer_copy(value)
            plain = SECItem(0, buffer, len(value))
            key_id, result = SECItem(), SECItem()
            status = encrypt_function(slot, ctypes.byref(key_id), 0x1082, ctypes.byref(plain), ctypes.byref(result), None) if aes else encrypt_function(ctypes.byref(key_id), ctypes.byref(plain), ctypes.byref(result), None)
            if status != 0:
                raise RuntimeError("NSS test encryption failed")
            try:
                return base64.b64encode(ctypes.string_at(result.data, result.len)).decode("ascii")
            finally:
                nss.SECITEM_ZfreeItem(ctypes.byref(result), 0)

        data = {"logins": [{
            "hostname": "https://nss-fixture.example",
            "encryptedUsername": encrypt(b"native fixture user"),
            "encryptedPassword": encrypt(b"native fixture password"),
        }]}
        (directory / "logins.json").write_text(json.dumps(data), encoding="utf-8")
    finally:
        if slot:
            nss.PK11_FreeSlot(slot)
        nss.NSS_Shutdown()


if __name__ == "__main__":
    make_fixture(sys.argv[1], Path(sys.argv[2]), "--aes" in sys.argv[3:])
