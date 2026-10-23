package maclauncher.android.framework;

import android.content.pm.*;
import android.os.Bundle;
import java.nio.file.*;
import java.security.cert.CertificateFactory;
import java.util.*;
import java.util.jar.JarFile;

/** Query compatibility never changes the actual publisher's identity or data ownership. */
public final class GoogleProviderTrustProbe {
    private static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static PackageInfo info(String name,SigningDetails details){var value=new PackageInfo();value.packageName=name;value.signatures=details.getSignatures().clone();value.signingInfo=new SigningInfo(details);return value;}
    public static void main(String[] args)throws Exception{
        maclauncher.android.fixture.RuntimeFixture.initialize(args[0],args[1]);
        byte[] certificate;
        try(var apk=new JarFile(args[2])){
            var entry=apk.stream().filter(item->item.getName().startsWith("META-INF/")&&item.getName().endsWith(".RSA")).findFirst().orElseThrow();
            try(var input=apk.getInputStream(entry)){certificate=CertificateFactory.getInstance("X.509").generateCertificates(input).iterator().next().getEncoded();}
        }
        Signature publisher=new Signature(certificate),compatible=new Signature(Files.readAllBytes(Path.of(args[3])));
        var original=new SigningDetails(new Signature[]{publisher},SigningDetails.SignatureSchemeVersion.JAR);
        var other=new SigningDetails(new Signature[]{compatible},SigningDetails.SignatureSchemeVersion.JAR);
        Bundle metadata=new Bundle();metadata.putString("fake-signature",compatible.toCharsString());
        var before=info("com.google.android.gms",original);HostGoogleProviders.describe(null,before,metadata,original);require(before.signatures[0].equals(publisher),"Default policy changed publisher");
        HostGoogleProviders.configure(true);
        for(String name:List.of("com.google.android.gms","com.android.vending")){
            var value=info(name,original);HostGoogleProviders.describe(null,value,metadata,original);
            require(value.signatures[0].equals(compatible),"Legacy SDK query lost compatibility identity");
            require(value.signingInfo.getApkContentsSigners()[0].equals(compatible),"Modern SDK query lost compatibility identity");
            require(original.getSignatures()[0].equals(publisher),"Query mutated real publisher");
        }
        var unrelated=info("example.game",original);HostGoogleProviders.describe(null,unrelated,metadata,original);require(unrelated.signatures[0].equals(publisher),"Unrelated package gained compatibility identity");
        var untrusted=info("com.google.android.gms",other);var untouched=untrusted.signatures;var untouchedInfo=untrusted.signingInfo;HostGoogleProviders.describe(null,untrusted,metadata,other);require(untrusted.signatures==untouched&&untrusted.signingInfo==untouchedInfo,"Untrusted metadata mutated");
        Bundle wrong=new Bundle();wrong.putString("fake-signature",publisher.toCharsString());var rejected=info("com.google.android.gms",original);HostGoogleProviders.describe(null,rejected,wrong,original);require(rejected.signatures[0].equals(publisher),"Arbitrary compatibility certificate accepted");
        Path data=Files.createTempDirectory(Path.of(args[1]),"account-identity-");
        try{
            HostAccountIdentity.bind(data,"com.google.android.gms",original);HostAccountIdentity.bind(data,"com.google.android.gms",original);
            try{HostAccountIdentity.bind(data,"com.google.android.gms",other);throw new AssertionError("A different publisher opened existing account storage");}catch(SecurityException expected){}
            try{HostAccountIdentity.bind(data,"com.android.vending",original);throw new AssertionError("A different package opened account storage");}catch(SecurityException expected){}
        }finally{try(var paths=Files.walk(data)){for(Path file:paths.sorted(Comparator.reverseOrder()).toList())Files.delete(file);}}
        System.out.println("PASS explicit provider query identity, unchanged publisher permissions and account storage continuity");
    }
}
