package io.github.ethanyoq.ainovelwriter;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Device-bound global secrets. Android Keystore keys are never exported. */
final class DeviceSecureStorage {
    static final int MAX_PLAIN_BYTES = 64 * 1024;
    private static final byte[] MAGIC = new byte[] { 'A', 'N', 'S', 'S', 1, 12 };
    private final String alias;
    private final byte[] context;

    static final class Failure extends Exception {
        final String code;
        Failure(String code) { super(code); this.code = code; }
    }

    DeviceSecureStorage(String packageName) {
        alias = packageName + ".device-secrets.v1";
        context = (packageName + "|device-secrets|v1").getBytes(StandardCharsets.UTF_8);
    }

    synchronized boolean available() {
        try { key(true); return true; } catch (Exception ignored) { return false; }
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        if (!create) throw new Failure("ANDROID_SECURE_STORAGE_KEY_UNAVAILABLE");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(false).build());
        return generator.generateKey();
    }

    synchronized String encrypt(String value) throws Failure {
        if (value == null) throw new Failure("ANDROID_SECURE_STORAGE_INPUT_INVALID");
        byte[] plain = value.getBytes(StandardCharsets.UTF_8);
        if (plain.length > MAX_PLAIN_BYTES) throw new Failure("ANDROID_SECURE_STORAGE_INPUT_INVALID");
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            cipher.updateAAD(context);
            byte[] iv = cipher.getIV();
            if (iv.length != 12) throw new Failure("ANDROID_SECURE_STORAGE_UNAVAILABLE");
            byte[] encrypted = cipher.doFinal(plain);
            ByteBuffer envelope = ByteBuffer.allocate(MAGIC.length + iv.length + encrypted.length);
            envelope.put(MAGIC).put(iv).put(encrypted);
            return Base64.encodeToString(envelope.array(), Base64.NO_WRAP);
        } catch (Failure error) { throw error; }
        catch (Exception ignored) { throw new Failure("ANDROID_SECURE_STORAGE_ENCRYPT_FAILED"); }
        finally { java.util.Arrays.fill(plain, (byte) 0); }
    }

    synchronized String decrypt(String encoded) throws Failure {
        if (encoded == null || encoded.length() > (MAX_PLAIN_BYTES + 64) * 2) throw new Failure("ANDROID_SECURE_STORAGE_INPUT_INVALID");
        byte[] bytes;
        try { bytes = Base64.decode(encoded, Base64.DEFAULT); }
        catch (Exception ignored) { throw new Failure("ANDROID_SECURE_STORAGE_INPUT_INVALID"); }
        if (bytes.length < MAGIC.length + 12 + 16 || bytes.length > MAX_PLAIN_BYTES + MAGIC.length + 12 + 16) {
            throw new Failure("ANDROID_SECURE_STORAGE_INPUT_INVALID");
        }
        for (int index = 0; index < MAGIC.length; index++) if (bytes[index] != MAGIC[index]) {
            throw new Failure("ANDROID_SECURE_STORAGE_INPUT_INVALID");
        }
        byte[] plain = null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, bytes, MAGIC.length, 12));
            cipher.updateAAD(context);
            plain = cipher.doFinal(bytes, MAGIC.length + 12, bytes.length - MAGIC.length - 12);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Failure error) { throw error; }
        catch (Exception ignored) { throw new Failure("ANDROID_SECURE_STORAGE_DECRYPT_FAILED"); }
        finally { if (plain != null) java.util.Arrays.fill(plain, (byte) 0); }
    }
}
