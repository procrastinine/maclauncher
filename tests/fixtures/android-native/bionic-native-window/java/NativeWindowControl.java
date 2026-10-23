import android.view.Surface;
import maclauncher.android.framework.HostSurface;
public final class NativeWindowControl {
    private static native void run(Surface surface);
    public static void main(String[] args) {
        System.load(args[0]);
        HostSurface.source = new Surface();
        run(HostSurface.source);
        System.out.println("PASS original native-window owner and generated 20-API carrier: JNI domain, ownership, geometry, errors, pending throwable");
    }
}
