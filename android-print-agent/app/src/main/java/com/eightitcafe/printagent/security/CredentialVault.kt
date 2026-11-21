package com.eightitcafe.printagent.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encrypts the long-lived print agent credential with an AES-256-GCM key that lives
 * in the Android Keystore (hardware-backed where available). The key is
 * non-exportable, so the ciphertext stored in SharedPreferences is useless if the
 * preferences file is copied off the device or restored onto another one.
 */
object CredentialVault {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "print_agent_credential_key_v1"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128
    private const val VERSION: Byte = 1

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    /** Returns base64(version | iv_len | iv | ciphertext+tag). */
    fun encrypt(plaintext: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val iv = cipher.iv
        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val out = ByteArray(2 + iv.size + ciphertext.size)
        out[0] = VERSION
        out[1] = iv.size.toByte()
        System.arraycopy(iv, 0, out, 2, iv.size)
        System.arraycopy(ciphertext, 0, out, 2 + iv.size, ciphertext.size)
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    /** Returns null if the blob is missing, corrupt, or was encrypted with another key. */
    fun decrypt(blob: String?): String? {
        if (blob.isNullOrEmpty()) return null
        return try {
            val data = Base64.decode(blob, Base64.NO_WRAP)
            if (data.size < 3 || data[0] != VERSION) return null
            val ivLen = data[1].toInt()
            val iv = data.copyOfRange(2, 2 + ivLen)
            val ciphertext = data.copyOfRange(2 + ivLen, data.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }
}
