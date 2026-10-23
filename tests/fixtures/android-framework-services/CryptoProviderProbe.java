import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.*;
import maclauncher.android.framework.HostCrypto;

/** Complete supplied provider registration and real cross-provider cipher bytes. */
public final class CryptoProviderProbe {
    public static void main(String[] args)throws Exception{
        Provider[] before=Security.getProviders();maclauncher.android.fixture.RuntimeFixture.initialize(args[0],args[1]);HostCrypto.initialize();HostCrypto.initialize();
        Provider[] after=Security.getProviders();for(int i=0;i<before.length;i++)if(after[i]!=before[i])throw new AssertionError("Existing provider order changed");
        if(args.length>2){
            String selected=Cipher.getInstance("PBEWithMD5AndDES").getProvider().getName();
            if(!selected.equals(args[2]))throw new AssertionError("Configured provider preference: "+selected);
            if(args.length>3&&!args[3].equals(Security.getProperty("jdk.tls.disabledAlgorithms")))throw new AssertionError("Configured TLS security property changed");
            System.out.println("PASS configured security properties and preference="+selected);return;
        }
        char[] password="Android PBE password".toCharArray();byte[] salt="0123456789abcdef".getBytes(StandardCharsets.US_ASCII),message="portable encrypted data".getBytes(StandardCharsets.UTF_8);
        var parameters=new PBEParameterSpec(salt,2048);
        for(String algorithm:new String[]{"PBEWithMD5AndDES","PBEWithSHA1AndDESede"}){
            SecretKeyFactory factory=SecretKeyFactory.getInstance(algorithm);
            if(!factory.getProvider().getName().equals("BC"))throw new AssertionError("PBE key factory provider: "+algorithm);
            SecretKey secret=factory.generateSecret(new PBEKeySpec(password));
            Cipher cipher=Cipher.getInstance(algorithm);cipher.init(Cipher.ENCRYPT_MODE,secret,parameters);
            if(!cipher.getProvider().getName().equals("BC"))throw new AssertionError("PBE cipher provider: "+algorithm);
            byte[] value=cipher.doFinal(message);
            String expected=algorithm.equals("PBEWithMD5AndDES")?"82b94f324fa770b201ac235a2eb4a0ecbba0f0303eab21e2":"414e882706f12765e6e79f365507e167321610432651ec39";
            if(!HexFormat.of().formatHex(value).equals(expected))throw new AssertionError("PBE vector changed: "+algorithm);
            Cipher original=Cipher.getInstance(algorithm,"BC");original.init(Cipher.ENCRYPT_MODE,SecretKeyFactory.getInstance(algorithm,"BC").generateSecret(new PBEKeySpec(password)),parameters);
            if(!Arrays.equals(value,original.doFinal(message)))throw new AssertionError("Android PBE bytes: "+algorithm);
            cipher.init(Cipher.DECRYPT_MODE,secret,parameters);if(!Arrays.equals(message,cipher.doFinal(value)))throw new AssertionError("PBE roundtrip");
            System.out.println("PBE "+algorithm+"="+HexFormat.of().formatHex(value));
        }
        Cipher sunCipher=Cipher.getInstance("PBEWithMD5AndDES","SunJCE");
        try{sunCipher.init(Cipher.ENCRYPT_MODE,SecretKeyFactory.getInstance("PBEWithMD5AndDES","SunJCE").generateSecret(new PBEKeySpec(password)),parameters);throw new AssertionError("SunJCE accepted a 16-byte PBES1 salt");}
        catch(InvalidAlgorithmParameterException expected){}
        SecretKey pbeKey=SecretKeyFactory.getInstance("PBEWithSHA1AndDESede","BC").generateSecret(new PBEKeySpec(password));
        for(String hash:new String[]{"SHA1"}){
            String algorithm="PBEWithHmac"+hash;
            Mac preferred=Mac.getInstance(algorithm);preferred.init(pbeKey,parameters);
            if(!preferred.getProvider().getName().equals("BC"))throw new AssertionError("PKCS12 Mac provider: "+algorithm);
            byte[] value=preferred.doFinal(message);Mac original=Mac.getInstance(algorithm,"BC");original.init(pbeKey,parameters);
            if(!HexFormat.of().formatHex(value).equals("f58297a1394fc7b6c9d1adc9cff518e051fd2dc6"))throw new AssertionError("PKCS12 Mac vector changed");
            if(!Arrays.equals(value,original.doFinal(message)))throw new AssertionError("Android PKCS12 Mac bytes: "+algorithm);
            Mac sun=Mac.getInstance(algorithm,"SunJCE");sun.init(pbeKey,parameters);
            if(Arrays.equals(value,sun.doFinal(message)))throw new AssertionError("PKCS12/PBKDF2 distinction disappeared: "+algorithm);
            System.out.println("PKCS12 "+algorithm+"="+HexFormat.of().formatHex(value));
        }
        for(String hash:new String[]{"SHA224","SHA256","SHA384","SHA512"}){
            String algorithm="PBEWithHmac"+hash;
            if(Security.getProvider("BC").getService("Mac",algorithm)!=null||!Mac.getInstance(algorithm).getProvider().getName().equals("SunJCE"))throw new AssertionError("Non-overlapping PBE Mac provider changed: "+algorithm);
        }
        for(String hash:new String[]{"SHA1","SHA224","SHA256","SHA384","SHA512"}){
            String algorithm="PBKDF2WithHmac"+hash;SecretKeyFactory factory=SecretKeyFactory.getInstance(algorithm);
            if(!factory.getProvider().getName().equals("SunJCE"))throw new AssertionError("PBKDF2 provider changed: "+algorithm);
            PBEKeySpec spec=new PBEKeySpec(password,salt,128,128);
            if(!Arrays.equals(factory.generateSecret(spec).getEncoded(),SecretKeyFactory.getInstance(algorithm,"BC").generateSecret(spec).getEncoded()))throw new AssertionError("PBKDF2 bytes differ");
        }
        byte[] key=new byte[16],iv=new byte[16],plain="Android payload \u03bb with complete padding".getBytes(StandardCharsets.UTF_8);
        new SecureRandom().nextBytes(key);new SecureRandom().nextBytes(iv);
        Cipher android=Cipher.getInstance("AES/CBC/PKCS7Padding");android.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(key,"AES"),new IvParameterSpec(iv));byte[] encrypted=android.doFinal(plain);
        Cipher jdk=Cipher.getInstance("AES/CBC/PKCS5Padding");jdk.init(Cipher.DECRYPT_MODE,new SecretKeySpec(key,"AES"),new IvParameterSpec(iv));if(!Arrays.equals(plain,jdk.doFinal(encrypted)))throw new AssertionError("Cipher interoperability");
        android.init(Cipher.DECRYPT_MODE,new SecretKeySpec(key,"AES"),new IvParameterSpec(iv));if(!Arrays.equals(plain,android.doFinal(encrypted)))throw new AssertionError("Original provider decode");
        KeyPairGenerator keys=KeyPairGenerator.getInstance("RSA","BC");keys.initialize(2048);KeyPair pair=keys.generateKeyPair();Signature signature=Signature.getInstance("SHA256withRSA");signature.initSign(pair.getPrivate());signature.update(plain);byte[] signed=signature.sign();signature.initVerify(pair.getPublic());signature.update(plain);if(!signature.verify(signed))throw new AssertionError("Provider signature interoperability");
        System.out.println("PASS complete Android crypto provider, preserved JVM providers and real cipher/signature operations");
    }
}
