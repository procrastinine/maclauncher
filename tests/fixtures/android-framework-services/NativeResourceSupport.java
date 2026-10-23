package maclauncher.android.test;

import android.content.res.Resources;
import java.nio.file.*;
import java.util.*;
import java.util.zip.ZipOutputStream;
import maclauncher.android.framework.FrameworkResources;

/** Loads the actual supplied resource engine for fixtures that use AOSP Resources. */
public final class NativeResourceSupport {
    private static boolean initialized;
    private static Path empty;
    private static Resources current;
    private NativeResourceSupport(){}
    private static Path runtime(){return Path.of(Objects.requireNonNull(System.getProperty("android.test.runtime"),"Android test runtime is required"));}
    public static synchronized Resources configure(Path...apks){
        try{
            Path runtime=runtime();
            if(!initialized){
                Path data=Files.createTempDirectory("android-resource-storage-");data.toFile().deleteOnExit();
                maclauncher.android.framework.HostFilesystem.configure(runtime,data,data,data,"owned.resources");
                System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());
                System.load(runtime.resolve("native/libnativebinding.dylib").toString());
                maclauncher.android.framework.JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));
                maclauncher.android.framework.JvmNativeMemory.initialize();initialized=true;
            }
            FrameworkResources.shutdown();FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apks));
            String[] splits=apks.length==1?null:Arrays.stream(apks).skip(1).map(Path::toString).toArray(String[]::new);
            current=android.app.ResourcesManager.getInstance().getResources(null,apks[0].toString(),splits,null,null,null,null,null,android.content.res.CompatibilityInfo.DEFAULT_COMPATIBILITY_INFO,NativeResourceSupport.class.getClassLoader(),null);return current;
        }catch(java.io.IOException error){throw new java.io.UncheckedIOException(error);}
    }
    public static synchronized Resources resources(){
        if(current!=null)return current;
            try{if(empty==null){empty=Files.createTempFile("android-owned-assets-",".apk");empty.toFile().deleteOnExit();try(var zip=new ZipOutputStream(Files.newOutputStream(empty))){}}}
            catch(java.io.IOException error){throw new java.io.UncheckedIOException(error);}
            return configure(empty);
    }
}
