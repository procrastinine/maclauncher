import android.app.ActivityManager;
import android.os.SystemProperties;
import maclauncher.android.fixture.RuntimeFixture;

/** Original framework queries against the real JVM and shared property owner. */
public final class HeapConfigurationProbe {
    public static void main(String[] args)throws Exception {
        RuntimeFixture.initialize(args[0],args[1]);
        int expected=(int)Math.min(Integer.MAX_VALUE,Math.max(1,Runtime.getRuntime().maxMemory()/(1024*1024)));
        if(ActivityManager.staticGetMemoryClass()!=expected||ActivityManager.staticGetLargeMemoryClass()!=expected)
            throw new AssertionError("Original ActivityManager disagrees with actual JVM heap limit");
        for(String name:new String[]{"dalvik.vm.heapsize","dalvik.vm.heapgrowthlimit"}) {
            String value=expected+"m";
            if(!value.equals(SystemProperties.get(name)))throw new AssertionError("Property value: "+name);
            var handle=SystemProperties.find(name);
            if(handle==null||!value.equals(handle.get()))throw new AssertionError("Shared property handle: "+name);
        }
        System.out.println("PASS original Android heap reporting matches JVM allowance: "+expected+" MiB");
        System.exit(0);
    }
}
