import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;
import javax.crypto.*;
import javax.crypto.spec.*;
import javax.net.ssl.*;
import com.android.org.conscrypt.Conscrypt;
import maclauncher.android.fixture.RuntimeFixture;

/** Original Android TLS, real loopback transport, and certificate rejection. */
public final class ConscryptTlsProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static void descriptor(SSLSocket socket)throws Exception{var method=socket.getClass().getMethod("getFileDescriptor$");method.setAccessible(true);check(((FileDescriptor)method.invoke(socket)).valid(),"Original Android socket descriptor API uses the live JDK socket");}
    static SSLContext context(KeyStore keys,KeyStore trust,String provider)throws Exception{
        KeyManager[] managers=null;
        if(keys!=null){KeyManagerFactory factory=KeyManagerFactory.getInstance("SunX509","SunJSSE");factory.init(keys,"test-password".toCharArray());managers=factory.getKeyManagers();}
        TrustManagerFactory factory=TrustManagerFactory.getInstance("PKIX",provider.equals("AndroidOpenSSL")?"HarmonyJSSE":"SunJSSE");factory.init(trust);
        SSLContext context=SSLContext.getInstance("TLS",provider);context.init(managers,factory.getTrustManagers(),new SecureRandom());return context;
    }
    static SSLContext androidTrustOnJdk(KeyStore trust)throws Exception{
        var provider=new android.security.net.config.NetworkSecurityConfigProvider();
        TrustManagerFactory factory=TrustManagerFactory.getInstance("PKIX",provider);factory.init(trust);
        TrustManager[] managers=factory.getTrustManagers();
        check(managers.length==1&&managers[0] instanceof android.security.net.config.RootTrustManager,"Original Android network security trust manager");
        SSLContext context=SSLContext.getInstance("TLS","SunJSSE");context.init(null,managers,new SecureRandom());return context;
    }
    static void certificateFailure(SSLException failure)throws Exception{
        Throwable cause=failure;boolean certificate=false;
        while(cause!=null){check(!(cause instanceof java.lang.reflect.InaccessibleObjectException),"JDK session must remain accessible to original Android trust verification");certificate|=cause instanceof java.security.cert.CertificateException;cause=cause.getCause();}
        check(certificate,"TLS rejection must come from certificate verification: "+failure);
    }
    static void jdkExchange(SSLContext server,SSLContext client,String host,boolean success,boolean http)throws Exception{
        try(SSLServerSocket listener=(SSLServerSocket)server.getServerSocketFactory().createServerSocket(0,1,InetAddress.getByName("127.0.0.1"))){
            listener.setSoTimeout(5000);ExecutorService executor=Executors.newSingleThreadExecutor();
            Future<?> response=executor.submit(()->{try(SSLSocket peer=(SSLSocket)listener.accept()){
                peer.setSoTimeout(5000);
                if(http){BufferedReader reader=new BufferedReader(new InputStreamReader(peer.getInputStream(),java.nio.charset.StandardCharsets.US_ASCII));String line;while((line=reader.readLine())!=null&&!line.isEmpty()){}
                    peer.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
                }else if(peer.getInputStream().read()==41)peer.getOutputStream().write(42);
            }catch(IOException failure){if(success)throw new UncheckedIOException(failure);}});
            try{try{
                if(http){HttpsURLConnection connection=(HttpsURLConnection)new URI("https://"+host+":"+listener.getLocalPort()+"/").toURL().openConnection(Proxy.NO_PROXY);
                    connection.setSSLSocketFactory(client.getSocketFactory());connection.setConnectTimeout(5000);connection.setReadTimeout(5000);
                    try{check(new String(connection.getInputStream().readAllBytes(),java.nio.charset.StandardCharsets.US_ASCII).equals("OK"),"HTTPS response");check(success,"Untrusted HTTPS peer accepted");}finally{connection.disconnect();}
                }else{try(Socket transport=new Socket("127.0.0.1",listener.getLocalPort());SSLSocket socket=(SSLSocket)client.getSocketFactory().createSocket(transport,host,listener.getLocalPort(),true)){
                    check(socket.getClass().getName().startsWith("sun.security.ssl."),"Actual JDK socket");
                    socket.setSoTimeout(5000);SSLParameters parameters=socket.getSSLParameters();parameters.setEndpointIdentificationAlgorithm("HTTPS");socket.setSSLParameters(parameters);
                    socket.startHandshake();check(success,"Untrusted TLS peer accepted");socket.getOutputStream().write(41);check(socket.getInputStream().read()==42,"JDK TLS application bytes");
                }}
            }catch(SSLException failure){if(success)throw failure;certificateFailure(failure);}
            response.get(7,TimeUnit.SECONDS);
            }finally{executor.shutdownNow();}
        }
    }
    static void jdkTrustPeers(KeyStore keys)throws Exception{
        KeyStore trusted=KeyStore.getInstance("PKCS12");trusted.load(null,null);trusted.setCertificateEntry("local",keys.getCertificate("local"));
        KeyStore empty=KeyStore.getInstance("PKCS12");empty.load(null,null);
        SSLContext server=context(keys,trusted,"SunJSSE"),client=androidTrustOnJdk(trusted),untrusted=androidTrustOnJdk(empty);
        for(boolean http:new boolean[]{false,true}){jdkExchange(server,client,"localhost",true,http);jdkExchange(server,client,"127.0.0.1",false,http);jdkExchange(server,untrusted,"localhost",false,http);}
        System.out.println("PASS original Android network security on JDK SSLSocket/HttpsURLConnection: trusted peer and certificate/hostname rejection");
    }
    static void exchange(SSLContext server,SSLContext client,boolean engine,String host,boolean success,boolean layered)throws Exception{
        try(SSLServerSocket listener=(SSLServerSocket)server.getServerSocketFactory().createServerSocket(0,1,InetAddress.getLoopbackAddress())){
            listener.setSoTimeout(5000);
            ExecutorService executor=Executors.newSingleThreadExecutor();
            Future<?> response=executor.submit(()->{try(SSLSocket peer=(SSLSocket)listener.accept()){peer.setSoTimeout(5000);int value=peer.getInputStream().read();if(value==41)peer.getOutputStream().write(42);}catch(IOException failure){if(success)throw new UncheckedIOException(failure);}});
            try{
                SSLSocketFactory factory=client.getSocketFactory();Conscrypt.setUseEngineSocket(factory,engine);
                try(Socket raw=layered?new Socket(InetAddress.getLoopbackAddress(),listener.getLocalPort()):null;SSLSocket socket=(SSLSocket)(layered?factory.createSocket(raw,host,listener.getLocalPort(),true):factory.createSocket(host,listener.getLocalPort()))){
                    socket.setSoTimeout(5000);SSLParameters parameters=socket.getSSLParameters();parameters.setEndpointIdentificationAlgorithm("HTTPS");socket.setSSLParameters(parameters);
                    socket.startHandshake();check(success,"Untrusted certificate/hostname accepted");descriptor(socket);socket.getOutputStream().write(41);check(socket.getInputStream().read()==42,"TLS application bytes");
                    check(socket.getSession().getPeerCertificates().length>0,"Actual server certificate");
                }catch(SSLHandshakeException expected){if(success)throw expected;}
                response.get(7,TimeUnit.SECONDS);
            }finally{executor.shutdownNow();}
        }
    }
    /** Like the Android host, end the process explicitly: Conscrypt's metrics
     * executor keeps a non-daemon worker after the first handshake. */
    public static void main(String[] args)throws Exception{run(args);System.exit(0);}
    private static void run(String[] args)throws Exception{
        Provider[] existing=Security.getProviders();RuntimeFixture.initialize(args[0],args[1]);
        Provider[] providers=Security.getProviders();for(int i=0;i<existing.length;i++)check(existing[i]==providers[i],"Existing JDK provider priority");
        check(Conscrypt.isAvailable(),"Complete JNI registration");
        KeyStore keys=KeyStore.getInstance("PKCS12");try(InputStream input=Files.newInputStream(Path.of(args[2]))){keys.load(input,"test-password".toCharArray());}
        if(args.length>3&&args[3].equals("jdk")){jdkTrustPeers(keys);return;}
        var nativeCertificate=(java.security.cert.X509Certificate)java.security.cert.CertificateFactory.getInstance("X.509","AndroidOpenSSL").generateCertificate(new ByteArrayInputStream(keys.getCertificate("local").getEncoded()));
        check(nativeCertificate.getSigAlgName().equals("SHA384withRSA"),"Original X509 algorithm/OID mapping");nativeCertificate.verify(nativeCertificate.getPublicKey());
        var oid=Class.forName("com.android.org.conscrypt.Platform").getDeclaredMethod("oidToAlgorithmName",String.class);oid.setAccessible(true);
        check(oid.invoke(null,"1.3.101.112").equals("Ed25519"),"Original JDK algorithm-name fallback");
        if(args.length>3&&args[3].equals("descriptor")){
            try(ServerSocket server=new ServerSocket(0,1,InetAddress.getLoopbackAddress())){
                SSLContext context=SSLContext.getInstance("TLS","AndroidOpenSSL");context.init(null,null,null);
                for(boolean engine:new boolean[]{true,false}){var factory=context.getSocketFactory();Conscrypt.setUseEngineSocket(factory,engine);try(SSLSocket socket=(SSLSocket)factory.createSocket("localhost",server.getLocalPort());Socket accepted=server.accept()){descriptor(socket);}}
            }
            System.out.println("PASS original Android SSL socket descriptor APIs retain the JDK owner");return;
        }
        KeyStore system=KeyStore.getInstance("AndroidCAStore");system.load(null,null);check(system.size()>100,"Original Android system CA catalog");
        int nativeMethods=0;for(var method:Class.forName("com.android.org.conscrypt.NativeCrypto").getDeclaredMethods())if(java.lang.reflect.Modifier.isNative(method.getModifiers()))nativeMethods++;
        check(nativeMethods==309,"Complete original native family retained: "+nativeMethods);
        byte[] bytes={1,2,3,4,5};Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding","AndroidOpenSSL");SecretKeySpec key=new SecretKeySpec(new byte[16],"AES");GCMParameterSpec parameters=new GCMParameterSpec(128,new byte[12]);cipher.init(Cipher.ENCRYPT_MODE,key,parameters);byte[] encrypted=cipher.doFinal(bytes);cipher.init(Cipher.DECRYPT_MODE,key,parameters);check(Arrays.equals(bytes,cipher.doFinal(encrypted)),"Native AES/GCM");
        KeyPairGenerator generator=KeyPairGenerator.getInstance("EC","AndroidOpenSSL");generator.initialize(new java.security.spec.ECGenParameterSpec("secp256r1"));KeyPair pair=generator.generateKeyPair();Signature signature=Signature.getInstance("SHA256withECDSA","AndroidOpenSSL");signature.initSign(pair.getPrivate());signature.update(bytes);byte[] signed=signature.sign();signature.initVerify(pair.getPublic());signature.update(bytes);check(signature.verify(signed),"Native EC parameters/signature");
        KeyStore trusted=KeyStore.getInstance("PKCS12");trusted.load(null,null);trusted.setCertificateEntry("local",keys.getCertificate("local"));
        SSLContext server=context(keys,trusted,"SunJSSE"),client=context(null,trusted,"AndroidOpenSSL");
        for(boolean engine:new boolean[]{true,false}){exchange(server,client,engine,"localhost",true,true);exchange(server,client,engine,"localhost",true,false);exchange(server,client,engine,"wrong.example.invalid",false,true);}
        KeyStore empty=KeyStore.getInstance("PKCS12");empty.load(null,null);exchange(server,context(null,empty,"AndroidOpenSSL"),true,"localhost",false,true);
        System.out.println("PASS all309 Android Conscrypt natives, original CA catalog, JDK provider order, EC/AES, real engine/FD TLS and certificate/hostname rejection");
    }
}
