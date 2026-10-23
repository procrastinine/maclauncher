package owned.live;
import maclauncher.android.bridge.GuestNativeLoader;
public final class Probe extends Parent {
 public static native int value();
 public static native int overloaded(int unused);
 public static native int manual();
 public static native int late();
 public static native int absent();
 public static void load(){GuestNativeLoader.loadLibrary("live-jni");}
}
