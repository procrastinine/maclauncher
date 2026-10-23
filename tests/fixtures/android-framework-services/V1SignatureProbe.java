import java.nio.file.Path;
import maclauncher.android.fixture.RuntimeFixture;
/** Original Android v1 APK verification against the existing JDK cryptography. */
public final class V1SignatureProbe {
    public static void main(String[] args)throws Exception{
        RuntimeFixture.initialize(args[0],args[1]);
        var parser=android.content.pm.parsing.result.ParseTypeImpl.forDefaultParsing();
        var valid=android.util.apk.ApkSignatureVerifier.verify(parser,args[2],1);
        if(valid.isError()||valid.getResult().getSignatures().length!=1)throw new AssertionError("Original v1 signature verification failed: "+valid.getErrorMessage(),valid.getException());
        var tampered=android.util.apk.ApkSignatureVerifier.verify(parser.reset(),args[3],1);
        if(!tampered.isError())throw new AssertionError("Modified signed APK was accepted");
        System.out.println("PASS original Android v1 signer verification and changed-entry rejection");
    }
}
