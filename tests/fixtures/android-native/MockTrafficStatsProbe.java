import android.net.INetworkStatsSession;
import android.net.NetworkStats;
import android.net.NetworkStatsHistory;
import android.net.TrafficStats;
import android.net.NetworkTemplate;
import android.content.ContextWrapper;
import android.net.connectivity.android.net.netstats.StatsResult;
import com.sun.management.UnixOperatingSystemMXBean;
import dalvik.system.SocketTagger;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.lang.management.ManagementFactory;
import java.lang.reflect.Modifier;
import maclauncher.android.framework.HostTrafficStats;

public final class MockTrafficStatsProbe {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
    private static void zero(StatsResult result) {
        check(result.rxBytes == 0 && result.rxPackets == 0 && result.txBytes == 0 && result.txPackets == 0,
            "Every counter must remain mocked, nonnegative and nondecreasing");
    }
    private static void empty(NetworkStats stats) {
        check(stats != null && stats.size() == 0 && stats.getTotalBytes() == 0 && stats.getTotalPackets() == 0,
            "Usage queries must return an empty mock rather than unavailable data");
    }
    private static void empty(NetworkStatsHistory history) {
        check(history != null && history.size() == 0 && history.getTotalBytes() == 0, "History must be an empty mock");
    }
    private static void stats(HostTrafficStats service) throws Exception {
        for (int uid : new int[]{-1, 0, 10000, Integer.MAX_VALUE}) zero(service.getUidStats(uid));
        for (String iface : new String[]{null, "", "lo0", "en0", "no-such-interface"}) zero(service.getIfaceStats(iface));
        zero(service.getTotalStats());
        check(service.getMobileIfaces().length == 0, "Mock device has no mobile interfaces");
        service.incrementOperationCount(10000, 42, 1);
        empty(service.getDataLayerSnapshotForUid(10000));empty(service.getUidStatsForTransport(0));
        for (INetworkStatsSession session : new INetworkStatsSession[]{service.openSession(), service.openSessionForUsageStats(0, "fixture")}) {
            empty(session.getDeviceSummaryForNetwork(null, 0, Long.MAX_VALUE));
            empty(session.getSummaryForNetwork(null, 0, Long.MAX_VALUE));
            empty(session.getSummaryForAllUid(null, 0, Long.MAX_VALUE, true));
            empty(session.getTaggedSummaryForAllUid(null, 0, Long.MAX_VALUE));
            empty(session.getHistoryForNetwork(null, -1));empty(session.getHistoryIntervalForNetwork(null, -1, 0, Long.MAX_VALUE));
            empty(session.getHistoryForUid(null, 10000, 0, 42, -1));
            empty(session.getHistoryIntervalForUid(null, 10000, 0, 42, -1, 0, Long.MAX_VALUE));
            check(session.getRelevantUids().length == 0, "Mock sessions reveal no host UIDs");
            session.close();
        }
    }
    private static void descriptorCycle() throws Exception {
        FileDescriptor closed;
        try (FileInputStream input = new FileInputStream("/dev/null")) {
            closed = input.getFD();
            for (int tag : new int[]{-1, 0, 42, Integer.MAX_VALUE}) {
                check(HostTrafficStats.native_tagSocketFd(closed, tag, 10000) == 0, "Tagging succeeds as a no-op");
                check(HostTrafficStats.native_untagSocketFd(closed) == 0, "Untagging succeeds as a no-op");
                TrafficStats.tagFileDescriptor(closed);TrafficStats.untagFileDescriptor(closed);
                check(closed.valid() && input.read() == -1, "Mock tagging preserves the caller's descriptor");
            }
        }
        check(!closed.valid(), "Caller close retires its own descriptor");
        check(HostTrafficStats.native_tagSocketFd(closed, 42, 10000) == 0, "Mock closed-descriptor tagging is a no-op");
        check(HostTrafficStats.native_untagSocketFd(null) == 0, "Mock null-descriptor untagging is a no-op");
    }
    public static void main(String[] args) throws Exception {
        var constructor = HostTrafficStats.class.getDeclaredConstructor();constructor.setAccessible(true);
        var service = constructor.newInstance();
        var taggerField = HostTrafficStats.class.getDeclaredField("TAGGER");taggerField.setAccessible(true);
        SocketTagger previous = SocketTagger.get();SocketTagger.set((SocketTagger)taggerField.get(null));
        try {
            for (var method : HostTrafficStats.class.getDeclaredMethods())
                check(!Modifier.isNative(method.getModifiers()), "Mock accounting needs no new native entry point");
            var descriptors = (UnixOperatingSystemMXBean)ManagementFactory.getOperatingSystemMXBean();
            var manager = HostTrafficStats.create(new ContextWrapper(null){
                @Override public String getOpPackageName(){return "mock.traffic.fixture";}
            });
            var bucket = manager.querySummaryForDevice(NetworkTemplate.buildTemplateWifiWildcard(), 0, Long.MAX_VALUE);
            check(bucket != null && bucket.getRxBytes() == 0 && bucket.getTxBytes() == 0
                && bucket.getRxPackets() == 0 && bucket.getTxPackets() == 0, "NetworkStatsManager receives mocked totals");
            stats(service);descriptorCycle();descriptors.getOpenFileDescriptorCount();
            long before = descriptors.getOpenFileDescriptorCount();
            for (int i = 0; i < 128; i++) { stats(service);descriptorCycle(); }
            check(descriptors.getOpenFileDescriptorCount() == before, "Mock accounting leaked descriptors");
        } finally { SocketTagger.set(previous); }
        System.out.println("PASS mocked device/interface/UID counters and usage sessions; 128 descriptor cycles without leaks");
    }
}
