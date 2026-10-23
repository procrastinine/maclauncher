package maclauncher.android;
import android.content.ComponentName;
import android.content.ServiceConnection;
import android.net.TrafficStats;
import android.os.IBinder;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public final class TrafficStatsProbe {
    private static int checks;
    private static void check(boolean value) {
        checks++;
        if (!value) throw new AssertionError("check " + checks);
    }
    public static void run() throws Exception {
        check(TrafficStats.getThreadStatsTag() == -1);
        TrafficStats.setThreadStatsTag(42);
        check(TrafficStats.getAndSetThreadStatsTag(Integer.MIN_VALUE) == 42);
        check(TrafficStats.getThreadStatsTag() == Integer.MIN_VALUE);
        check(TrafficStats.getAndSetThreadStatsTag(42) == Integer.MIN_VALUE);
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var failure = new AtomicReference<Throwable>();
        Thread worker = new Thread(() -> {
            try {
                if (TrafficStats.getThreadStatsTag() != -1) throw new AssertionError("tag inherited");
                TrafficStats.setThreadStatsTag(99);
                entered.countDown();
                if (!release.await(2, TimeUnit.SECONDS)) throw new AssertionError("owner timeout");
                if (TrafficStats.getThreadStatsTag() != 99) throw new AssertionError("cross-thread tag");
                TrafficStats.clearThreadStatsTag();
                if (TrafficStats.getThreadStatsTag() != -1) throw new AssertionError("clear failed");
            } catch (Throwable error) { failure.set(error); }
            finally { entered.countDown(); TrafficStats.clearThreadStatsTag(); }
        }, "owned-traffic-tag");
        worker.setDaemon(true);
        worker.start();
        try {
            check(entered.await(2, TimeUnit.SECONDS));
            check(TrafficStats.getThreadStatsTag() == 42);
            TrafficStats.clearThreadStatsTag();
            check(TrafficStats.getThreadStatsTag() == -1);
        } finally { release.countDown(); worker.join(2500); TrafficStats.clearThreadStatsTag(); }
        check(!worker.isAlive() && failure.get() == null);
        TrafficStats.setThreadStatsTag(0);
        try { throw new IllegalStateException("owned failure"); }
        catch (IllegalStateException expected) { check(TrafficStats.getThreadStatsTag() == 0); }
        finally { TrafficStats.clearThreadStatsTag(); }
        check(TrafficStats.getThreadStatsTag() == -1);
        check(TrafficStats.getAndSetThreadStatsTag(-1) == -1);
        for (String prefix : new String[]{"Mobile", "Total", "Uid"}) {
            for (String suffix : new String[]{"TxPackets", "RxPackets", "TxBytes", "RxBytes"}) {
                var method = TrafficStats.class.getMethod("get" + prefix + suffix,
                    prefix.equals("Uid") ? new Class<?>[]{int.class} : new Class<?>[0]);
                check(method.getReturnType() == long.class);
                long value=(long)method.invoke(null,prefix.equals("Uid")?new Object[]{android.os.Process.myUid()}:new Object[0]);
                check(value>=0||value==TrafficStats.UNSUPPORTED);
            }
        }
        var component = new ComponentName("example.app", "example.app.Service");
        IBinder token = new android.os.Binder();
        Object[] callbacks = new Object[3];
        ServiceConnection listener = new ServiceConnection() {
            public void onServiceConnected(ComponentName name, IBinder binder) { callbacks[0] = name; callbacks[1] = binder; }
            public void onServiceDisconnected(ComponentName name) { callbacks[2] = name; }
        };
        listener.onBindingDied(component);
        listener.onNullBinding(component);
        check(callbacks[0] == null && callbacks[1] == null && callbacks[2] == null);
        listener.onServiceConnected(component, token);
        listener.onServiceDisconnected(component);
        check(callbacks[0] == component && callbacks[1] == token && callbacks[2] == component);
        check(ServiceConnection.class.getMethod("onBindingDied", ComponentName.class).isDefault());
        check(ServiceConnection.class.getMethod("onNullBinding", ComponentName.class).isDefault());

    }
}
