package maclauncher.android.framework;

import java.io.*;
import java.lang.reflect.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.DynamicDex;
import maclauncher.android.bridge.GuestNativeLoader;
import maclauncher.android.fixture.RuntimeFixture;

/** Executes the original APK's full Java SDK and original Android JNI library. */
public final class ZstdSdkProbe {
    static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]).toRealPath(),apk=Path.of(args[1]).toRealPath(),nativeRoot=Path.of(args[2]).toRealPath(),index=Path.of(args[3]).toRealPath(),data=Files.createDirectories(Path.of(args[4])).toRealPath();
        RuntimeFixture.initialize(runtime.toString(),data.toString());
        HostContext.hostPackage("owned.zstd.fixture","1",1);
        HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),nativeRoot.toString(),28);
        ClassLoader app=HostDexFiles.application(index,List.of(apk),nativeRoot,ZstdSdkProbe.class.getClassLoader());
        HostContext.hostClassLoader(app);
        GuestNativeLoader.configure(runtime.resolve("native/libklepton-jvm.dylib").toString(),nativeRoot.toString(),index.toString(),app);
        DynamicDex.configure(runtime,Files.createDirectories(data.resolve("cache")),index,app);
        try {
            Class<?> input=Class.forName("com.github.luben.zstd.ZstdInputStream",true,app),output=Class.forName("com.github.luben.zstd.ZstdOutputStream",true,app);
            // Executing the original constructor exposes the donor stub in the
            // baseline instead of merely checking a name or archive listing.
            try(var ignored=(InputStream)input.getConstructor(InputStream.class).newInstance(new ByteArrayInputStream(new byte[0]))){}
            int classes=0;
            for(String name:DynamicDex.preparedClassNames(index))if(name.startsWith("com.github.luben.zstd.")){
                check(Class.forName(name,false,app).getClassLoader()==app,"original SDK class owner: "+name);classes++;
            }
            check(classes>20,"complete original SDK family was indexed and resolved");
            System.out.println("PASS original SDK family resolution classes="+classes);
            Class<?> zstd=Class.forName("com.github.luben.zstd.Zstd",true,app);
            for(int length:new int[]{0,1,16,4097}){
                byte[] plain=new byte[length];for(int i=0;i<length;i++)plain[i]=(byte)(i*31+i/17);
                byte[] compressed=(byte[])zstd.getMethod("compress",byte[].class,int.class).invoke(null,plain,3);
                byte[] restored=(byte[])zstd.getMethod("decompress",byte[].class,int.class).invoke(null,compressed,length);
                check(Arrays.equals(plain,restored),"original JNI byte-array roundtrip "+length);
                ByteArrayOutputStream bytes=new ByteArrayOutputStream();
                try(OutputStream stream=(OutputStream)output.getConstructor(OutputStream.class,int.class).newInstance(bytes,3)){
                    output.getMethod("setChecksum",boolean.class).invoke(stream,true);stream.write(plain);stream.flush();
                }
                byte[] frame=bytes.toByteArray();
                check(frame.length>=4&&(frame[0]&255)==0x28&&(frame[1]&255)==0xb5&&(frame[2]&255)==0x2f&&(frame[3]&255)==0xfd,"original Zstandard frame");
                try(InputStream stream=(InputStream)input.getConstructor(InputStream.class).newInstance(new ByteArrayInputStream(frame))){check(Arrays.equals(plain,stream.readAllBytes()),"original JNI stream roundtrip "+length);}
                frame[frame.length-1]^=1;
                try(InputStream stream=(InputStream)input.getConstructor(InputStream.class).newInstance(new ByteArrayInputStream(frame))){
                    stream.readAllBytes();throw new AssertionError("Corrupt checksum accepted");
                }catch(IOException expected){}
            }
            System.out.println("PASS original JNI streams and byte arrays: 0/1/16/4097 bytes, checksum rejection");
        }finally{DynamicDex.hostShutdown();HostDexFiles.clearInstalled();}
    }
}
