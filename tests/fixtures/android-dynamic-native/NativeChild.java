package owned.dynamic;
import maclauncher.android.bridge.DynamicGuestNativeLoader;
import maclauncher.android.bridge.GuestNativeLoader;
public final class NativeChild {
 public static native int value();
 public static void load(){GuestNativeLoader.loadLibrary("dynamic");}
 public static void preparedRuntimeLoad(){GuestNativeLoader.runtimeLoadLibrary(Runtime.getRuntime(),"dynamic");}
 public static void runtimeLoad(){DynamicGuestNativeLoader.runtimeLoadLibrary(Runtime.getRuntime(),"dynamic");}
}
