import android.util.Log;
import java.nio.file.Path;
import maclauncher.android.framework.JvmNativeMemory;

public final class NativeLoggingProbe {
    public static void main(String[] args){
        Path runtime=Path.of(args[0]);
        System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());
        System.load(runtime.resolve("native/libnativebinding.dylib").toString());
        JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));
        JvmNativeMemory.initialize();
        // Every original Log JNI entry is exercised, including the one reached
        // by AssetManager before an Activity or application logger exists.
        if(Log.println(Log.INFO,"NativeLoggingProbe","publisher logging")<0)throw new AssertionError("Native log write failed");
        Log.isLoggable("NativeLoggingProbe",Log.INFO);
        if(Log.printlns(0,Log.INFO,"NativeLoggingProbe","publisher chunked logging",null)<0)throw new AssertionError("Native chunked log write failed");
        System.out.println("PASS original publisher logging");
    }
}
