import java.nio.file.*;
import maclauncher.android.bridge.NativeBinding;
import maclauncher.android.fixture.RuntimeFixture;

public final class ZlibGuestProbe {
    private static native void compression();
    private static native void files(String directory);
    public static void main(String[] args)throws Exception {
        RuntimeFixture.initialize(args[0],args[1]);
        Path runtime=Path.of(args[0]);
        long image=NativeBinding.load(runtime.resolve("native/libklepton-jvm.dylib").toString(),args[2],"libzprobe.so");
        NativeBinding.bind(image,ZlibGuestProbe.class);
        compression();files(args[1]);
        System.out.println("PASS installed original guest compression and gzip ownership");
    }
}
