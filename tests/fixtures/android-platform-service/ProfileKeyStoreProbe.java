package maclauncher.android;

import java.nio.file.*;
import java.security.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import java.util.Arrays;
import android.security.keystore.*;
import android.security.keystore2.AndroidKeyStoreProvider;
import maclauncher.android.framework.*;

/** Full original service accessed through the same inherited authority as an APK. */
public final class ProfileKeyStoreProbe {
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Path.of(args[1]);
        Path files=Files.createDirectories(data.resolve("files")),cache=Files.createDirectories(data.resolve("cache"));
        String name=args[2];
        RuntimeBootstrap.initialize(runtime,data,files,cache,name,false,false,false);
        try(var authority=ProcessAuthority.read(5,name,name)) {
            // The original two-field bootstrap remains available in retained runtimes.
            HostProcessIdentity.configure(authority.self.uid(),authority.self.hostUid());
            authority.attachPlatform();
            AndroidKeyStoreProvider.install();
            KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
            String alias="profile-service-key";
            if(args[3].equals("create")) {
                KeyGenerator generator=KeyGenerator.getInstance("AES","AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
                generator.generateKey();
            }
            boolean present=store.containsAlias(alias)&&store.getKey(alias,null)!=null;
            if(present==args[3].equals("deny"))throw new AssertionError("Persistent UID key ownership failed");
            if(present) {
                var key=store.getKey(alias,null);
                byte[] aad="isolated-profile-gcm".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                for(int size:new int[]{0,1,16,4097}) {
                    byte[] plain=new byte[size];for(int i=0;i<size;i++)plain[i]=(byte)(i*31+7);
                    Path sample=files.resolve("synthetic-gcm-"+size);
                    if(args[3].equals("create")) {
                        Cipher encrypt=Cipher.getInstance("AES/GCM/NoPadding","AndroidKeyStoreBCWorkaround");
                        encrypt.init(Cipher.ENCRYPT_MODE,key);encrypt.updateAAD(aad);
                        byte[] encrypted=encrypt.doFinal(plain),iv=encrypt.getIV();
                        if(iv.length!=12)throw new AssertionError("Unexpected GCM nonce length");
                        byte[] encoded=Arrays.copyOf(iv,iv.length+encrypted.length);
                        System.arraycopy(encrypted,0,encoded,iv.length,encrypted.length);Files.write(sample,encoded);
                    }
                    byte[] encoded=Files.readAllBytes(sample);
                    Cipher decrypt=Cipher.getInstance("AES/GCM/NoPadding","AndroidKeyStoreBCWorkaround");
                    decrypt.init(Cipher.DECRYPT_MODE,key,new GCMParameterSpec(128,Arrays.copyOf(encoded,12)));
                    decrypt.updateAAD(aad);
                    if(!Arrays.equals(plain,decrypt.doFinal(encoded,12,encoded.length-12)))throw new AssertionError("Persistent GCM plaintext mismatch");
                    encoded[encoded.length-1]^=1;
                    decrypt.init(Cipher.DECRYPT_MODE,key,new GCMParameterSpec(128,Arrays.copyOf(encoded,12)));
                    decrypt.updateAAD(aad);
                    try{decrypt.doFinal(encoded,12,encoded.length-12);throw new AssertionError("GCM accepted an invalid tag");}
                    catch(AEADBadTagException expected){}
                }
            }
            if(args.length>4) {
                try { Files.readString(Path.of(args[4])); throw new AssertionError("Private controller metadata became game-readable"); }
                catch(java.io.IOException expected) {}
                try(var socket=java.nio.channels.SocketChannel.open(java.net.StandardProtocolFamily.UNIX)) {
                    try { socket.connect(java.net.UnixDomainSocketAddress.of(args[5])); throw new AssertionError("Game connected to private enrollment endpoint"); }
                    catch(java.io.IOException expected) {}
                }
            }
            System.out.println("PASS profile KeyStore "+args[3]+" uid="+authority.self.uid());
        } finally { HostRemoteServices.shutdown(); }
        System.exit(0);
    }
}
