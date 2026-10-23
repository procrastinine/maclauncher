package maclauncher.android.framework;
import android.view.Surface;
public final class HostSurface {
    public static long lease;
    public static Surface source;
    public static long nativeLease(Surface surface) { return surface == source ? lease : 0; }
    public static Surface fromNativeHandle(long handle) { return handle == 7 ? source : null; }
}
