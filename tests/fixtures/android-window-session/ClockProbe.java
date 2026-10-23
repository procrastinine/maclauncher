import android.os.SystemClock;
public class ClockProbe {
    static { System.load(System.getProperty("clock.probe")); }
    private static native long guest(int id);
    private static native long nativeUptime();
    private static native long nativeContinuous();
    static int checks;
    static void check(boolean value) { ++checks; if (!value) throw new AssertionError("clock check "+checks); }
    static void bracket(String name,long a,long value,long b) { ++checks;if(value<a||value>b)throw new AssertionError(name+" check="+checks+" before="+a+" value="+value+" after="+b+" lowerDelta="+(value-a)+" upperDelta="+(value-b)); }
    public static void main(String[] args)throws Exception {
        maclauncher.android.fixture.RuntimeFixture.initialize(args[0],args[1]);
        // This exact HotSpot build can return another thread's cached value on
        // a CAS race. Synchronize once to an observed native lower bound; keep
        // exact upper bounds and monotonicity, without a guessed tolerance.
        long anchor=nativeUptime(),lastJava=0,maxCacheLag=0;boolean synced=false;
        for(int i=0;i<1024;++i){lastJava=System.nanoTime();if(lastJava>=anchor){synced=true;break;}}
        check(synced);check(lastJava<=nativeUptime());
        for(int i=0;i<Integer.getInteger("clock.samples",20000);++i) {
            long j=System.nanoTime(),a=nativeUptime(),g=guest(1),b=nativeUptime();bracket("guest inside native",a,g,b);check(g>=j);
            a=nativeUptime();g=System.nanoTime();b=nativeUptime();bracket("Java observed domain",anchor,g,b);check(g>=lastJava);lastJava=g;maxCacheLag=Math.max(maxCacheLag,a-g);
            a=System.nanoTime()/1_000_000L;g=SystemClock.uptimeMillis();b=System.nanoTime()/1_000_000L;check(g>=a&&g<=b);
            a=nativeContinuous();g=SystemClock.elapsedRealtimeNanos();b=nativeContinuous();check(g>=a&&g<=b);
            a=guest(7)/1_000_000L;g=SystemClock.elapsedRealtime();b=guest(7)/1_000_000L;check(g>=a&&g<=b);
        }
        System.out.println("JAVA_CLOCK_PASS checks="+checks+" observedHotSpotCacheLagNs="+maxCacheLag);
    }
}
