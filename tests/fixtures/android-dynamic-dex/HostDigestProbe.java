package maclauncher.android;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.Arrays;
import java.util.HexFormat;

/** A provider may need the same class cache whose keys need a digest. */
public final class HostDigestProbe {
    private static Method cacheKey;
    private static boolean constructing;
    private static int constructions;

    private static String key()throws Exception{
        try{return (String)cacheKey.invoke(null,"source-content-hash","fixture.PendingProvider");}
        catch(InvocationTargetException failure){
            if(failure.getCause() instanceof Error error)throw error;
            throw failure;
        }
    }
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}

    private static final class GuestDigest extends MessageDigestSpi {
        private final MessageDigest original;
        GuestDigest(Provider provider)throws NoSuchAlgorithmException{original=MessageDigest.getInstance("SHA-256",provider);}
        @Override protected void engineUpdate(byte value){original.update(value);}
        @Override protected void engineUpdate(byte[] value,int offset,int length){original.update(value,offset,length);}
        @Override protected byte[] engineDigest(){return original.digest();}
        @Override protected void engineReset(){original.reset();}
        @Override protected int engineGetDigestLength(){return original.getDigestLength();}
    }

    public static void main(String[] args)throws Exception{
        HostDigests.initialize();
        Provider original=HostDigests.sha256().getProvider();
        cacheKey=DynamicDex.class.getDeclaredMethod("classKey",String.class,String.class);cacheKey.setAccessible(true);
        String expected=key();
        byte[] abc="abc".getBytes(StandardCharsets.UTF_8);
        Provider guest=new Provider("FixtureAndroidProvider","1.0","Class-loading digest provider"){
            {
                putService(new Service(this,"MessageDigest","SHA-256",GuestDigest.class.getName(),null,null){
                    @Override public Object newInstance(Object parameter)throws NoSuchAlgorithmException{
                        check(!constructing,"Cache hashing re-entered the APK provider during provider class loading");
                        constructing=true;constructions++;
                        try{check(key().equals(expected),"Provider class cache changed");return new GuestDigest(original);}
                        catch(Exception failure){throw new NoSuchAlgorithmException("Cannot define provider implementation",failure);}
                        finally{constructing=false;}
                    }
                });
            }
        };
        Security.insertProviderAt(guest,1);
        check(key().equals(expected),"Guest provider ordering changed content identity");
        check(constructions==0,"Internal hashing loaded the APK provider");
        check(HexFormat.of().formatHex(HostDigests.sha256().digest(abc)).equals(
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),"SHA-256 bytes changed");
        Security.removeProvider(original.getName());
        check(key().equals(expected),"Removing the original provider broke retained cache hashing");
        MessageDigest application=MessageDigest.getInstance("SHA-256");
        check(application.getProvider()==guest,"Runtime hashing changed APK provider selection");
        check(Arrays.equals(application.digest(abc),HostDigests.sha256().digest(abc)),"APK provider stopped functioning");
        check(constructions==1&&Security.getProviders()[0]==guest,"Application provider configuration changed");
        MessageDigest first=HostDigests.sha256(),second=HostDigests.sha256();
        first.update((byte)'a');second.update(abc);first.update(new byte[]{'b','c'});
        check(first!=second&&Arrays.equals(first.digest(),second.digest()),"Concurrent hashes share mutable digest state");
        System.out.println("PASS original VM digest ownership, APK provider class loading and unchanged content identities");
    }
}
