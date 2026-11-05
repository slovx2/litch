package dev.litch.ssh

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Log
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// 密钥不可导出；密文排除系统备份。Go 同步保存完整状态，失败必须向上传播。
class TailscaleStorage(context: Context) : sshtransport.TailscaleStorage {
  private val file = AtomicFile(File(context.noBackupFilesDir, "tailscale-state.enc"))
  private val alias = "litch.tailscale.state"
  private val aad = "litch.tailscale.state.v1".toByteArray(Charsets.UTF_8)

  private fun key(create: Boolean): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(alias, null) as? SecretKey)?.let { return it }
    check(create) { "Tailscale state key is unavailable; clear state to sign in again" }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256).build())
    }.generateKey()
  }

  @Synchronized override fun read(): String {
    val encoded = try { file.readFully() } catch (error: FileNotFoundException) {
      if (!file.baseFile.exists()) return ""
      throw error
    }
    check(encoded.size >= 29 && encoded[0] == 1.toByte()) { "Invalid encrypted Tailscale state" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, encoded.copyOfRange(1, 13)))
    cipher.updateAAD(aad)
    val state = cipher.doFinal(encoded.copyOfRange(13, encoded.size)).toString(Charsets.UTF_8)
    Log.i("LitchTailscale", "encrypted state restored")
    return state
  }

  @Synchronized override fun write(state: String) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key(!file.baseFile.exists()))
    cipher.updateAAD(aad)
    val encoded = byteArrayOf(1) + cipher.iv + cipher.doFinal(state.toByteArray(Charsets.UTF_8))
    val stream = file.startWrite()
    try {
      stream.write(encoded)
      file.finishWrite(stream)
      Log.i("LitchTailscale", "encrypted state saved")
    } catch (error: Exception) {
      file.failWrite(stream)
      throw error
    }
  }

  @Synchronized override fun clear() {
    file.delete()
    check(!file.baseFile.exists()) { "Could not remove encrypted Tailscale state" }
    KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(alias) }
  }
}
