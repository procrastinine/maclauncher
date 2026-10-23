import com.android.apksig.ApkSigner;
import java.nio.file.*;
import java.security.*;
import java.security.cert.X509Certificate;
import java.util.*;

/** Signs only generated test packages with the generated, temporary test key. */
public final class SignApkSet {
    public static void main(String[] args)throws Exception {
        KeyStore store=KeyStore.getInstance("PKCS12");
        try(var in=Files.newInputStream(Path.of(args[0]))){store.load(in,"test-only-password".toCharArray());}
        var key=(PrivateKey)store.getKey("owned","test-only-password".toCharArray());
        var certificate=(X509Certificate)store.getCertificate("owned");
        var signer=new ApkSigner.SignerConfig.Builder("owned",key,List.of(certificate)).build();
        for(int i=1;i<args.length;i+=2)new ApkSigner.Builder(List.of(signer)).setInputApk(Path.of(args[i]).toFile())
            .setOutputApk(Path.of(args[i+1]).toFile()).setMinSdkVersion(1).setV1SigningEnabled(true)
            .setV2SigningEnabled(true).setV3SigningEnabled(true).build().sign();
    }
}
