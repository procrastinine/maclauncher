package maclauncher.android.framework;

import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import com.android.internal.pm.parsing.pkg.AndroidPackageHidden;

/** Original cluster parsing, without loading or starting application code. */
public final class FeatureSplitProbe {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
    public static void main(String[] args) throws Exception {
        if (args[0].equals("attributes")) {
            for (String name : List.of("name", "minSdkVersion", "targetSdkVersion", "versionCode", "versionName", "label", "hasCode",
                    "process", "permission", "enabled", "exported", "authorities", "targetActivity", "value", "isFeatureSplit")) {
                java.lang.reflect.Field field;
                try { field = android.R.attr.class.getField(name); }
                catch (NoSuchFieldException hidden) { field = com.android.internal.R.attr.class.getField(name); }
                System.out.println(name + "=" + field.getInt(null));
            }
            return;
        }
        Path runtime = Path.of(args[0]), data = Path.of(args[1]);
        var loop = maclauncher.android.fixture.RuntimeFixture.initialize(args[0], args[1]);
        try {
            List<Path> sources = Arrays.stream(args).skip(2).map(Path::of).toList();
            FrameworkResources.configure(runtime.resolve("android-framework.jar"), sources);
            var parsed = HostPackageParser.parseSources(sources, data.resolve("cache"));
            var app = ((AndroidPackageHidden) parsed).toAppInfoWithoutState();
            check(app.className.equals("org.example.game.BaseApplication"), "Base application class retained");
            check(app.processName.equals("org.example.game:shared"), "Base process retained");
            check(app.enabled && app.targetSdkVersion == 36, "Base enabled and SDK defaults retained");
            check(Arrays.equals(app.splitNames, new String[]{"feature.alpha", "feature.zeta"}), "Original sorted split names");
            check(app.splitSourceDirs.length == 2, "Both original split source paths retained");
            check(parsed.getMetaData().getString("duplicate").equals("zeta"), "Original split metadata replacement order");
            check(parsed.getActivities().stream().filter(item -> item.getName().startsWith("org.example.game.")).count() == 3,
                    "Base, feature activity and cross-split alias parsed: " + parsed.getActivities().stream().map(item -> item.getName()).toList());
            var feature = parsed.getActivities().stream().filter(item -> item.getName().endsWith(".Feature")).findFirst().orElseThrow();
            check(feature.getProcessName().equals(app.processName) && feature.getPermission().equals("org.example.ACCESS"), "Feature activity inherits base defaults");
            check(feature.getSplitName().equals("feature.alpha"), "Original activity split dispatch identity");
            var alias = parsed.getActivities().stream().filter(item -> item.getName().endsWith(".FeatureAlias")).findFirst().orElseThrow();
            check(alias.getTargetActivity().equals("org.example.game.Base"), "Feature alias targets base activity");
            check(parsed.getProviders().size() == 1 && parsed.getServices().size() == 1 && parsed.getReceivers().size() == 1, "All split component families parsed");
            var provider = parsed.getProviders().getFirst();
            check(!provider.isExported() && provider.getReadPermission().equals("org.example.ACCESS"), "Provider inherits base target SDK and permissions");
            for (var item : List.of(provider, parsed.getServices().getFirst(), parsed.getReceivers().getFirst())) {
                check(item.isEnabled() && item.getProcessName().equals(app.processName), "Split component enabled and process defaults");
                check(item.getSplitName().equals("feature.alpha"), "Original component split identity retained");
            }
            System.out.println("PASS original signed feature split components and base inheritance");
        } finally { FrameworkResources.shutdown(); HostLooper.close(loop); }
        System.exit(0);
    }
}
