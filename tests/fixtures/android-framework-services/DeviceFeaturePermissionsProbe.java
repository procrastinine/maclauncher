package maclauncher.android.framework;

import android.content.pm.PackageManager;
import android.util.DisplayMetrics;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;

/** Original manifest parsing and package queries consume the same virtual device. */
public final class DeviceFeaturePermissionsProbe {
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    public static void main(String[] args) throws Exception {
        Path runtime = Path.of(args[0]), apk = Path.of(args[2]);
        var loop = maclauncher.android.fixture.RuntimeFixture.initialize(args[0], args[1]);
        try {
            FrameworkResources.configure(runtime.resolve("android-framework.jar"), List.of(apk));
            var metrics = new DisplayMetrics(); metrics.setToDefaults();
            var parsed = PackageParsing.parse(apk, 0, metrics);
            var permissions = Set.copyOf(parsed.getRequestedPermissions());
            check(permissions.contains("org.example.AUDIO_PRESENT"), "Existing audio output keeps its conditional permission");
            check(!permissions.contains("org.example.AUDIO_ABSENT"), "requiredNotFeature excludes an existing output");
            check(!permissions.contains("org.example.WATCH_PRESENT"), "Absent hardware does not grant a conditional permission");
            check(permissions.contains("org.example.WATCH_ABSENT"), "requiredNotFeature retains absent-hardware branch");
            for (String name : List.of(PackageManager.FEATURE_AUDIO_OUTPUT, PackageManager.FEATURE_FAKETOUCH,
                PackageManager.FEATURE_SCREEN_LANDSCAPE, PackageManager.FEATURE_SCREEN_PORTRAIT)) {
                check(HostActivityManager.hostHasSystemFeature(name, 0), "Existing virtual capability: " + name);
                check(!HostActivityManager.hostHasSystemFeature(name, 1), "Unspecified feature version is zero");
            }
            check(!HostActivityManager.hostHasSystemFeature(PackageManager.FEATURE_CAMERA, 0), "No implicit host camera");
            check(!HostActivityManager.hostHasSystemFeature(PackageManager.FEATURE_MICROPHONE, 0), "No implicit host microphone");
            var queried = HostActivityManager.class.getDeclaredField("graphicsQueried"); queried.setAccessible(true);
            check(!queried.getBoolean(null), "Named device and parser queries do not initialize graphics");
            System.out.println("PASS original parser conditional permissions share device feature owner");
        } finally { FrameworkResources.shutdown(); HostLooper.close(loop); }
        System.exit(0);
    }
}
