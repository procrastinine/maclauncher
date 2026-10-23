import android.system.SystemCleaner;
import java.lang.ref.Cleaner;
import java.util.concurrent.atomic.AtomicInteger;

public final class SharedCleanerProbe {
    public static void main(String[] args) throws Exception {
        Cleaner original = SystemCleaner.cleaner();
        Cleaner jdk = (Cleaner) Class.forName("jdk.internal.ref.CleanerFactory")
                .getMethod("cleaner").invoke(null);
        if (original != jdk || original != SystemCleaner.cleaner())
            throw new AssertionError("Android must retain the JDK's shared cleaner owner");
        AtomicInteger releases = new AtomicInteger();
        Object resource = new Object();
        Cleaner.Cleanable cleanup = original.register(resource, releases::incrementAndGet);
        cleanup.clean();
        cleanup.clean();
        if (releases.get() != 1) throw new AssertionError("Resource cleanup must run exactly once");
        java.lang.ref.Reference.reachabilityFence(resource);
        System.out.println("PASS original Android SystemCleaner shares JDK cleanup ownership");
    }
}
