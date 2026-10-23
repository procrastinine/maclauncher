package maclauncher.android;

public final class ArtLogInitProbe {
    private static native int probe();
    private static void reportAfterClose() {
        IllegalStateException original=new IllegalStateException("original failure after guest stderr close");
        boolean cleanup=false;
        try {
            try { throw original; }
            catch(IllegalStateException failure) { FirstFailure.reportOwner(failure);throw failure; }
            finally { cleanup=true; }
        } catch(IllegalStateException failure) {
            if(failure!=original||!cleanup)throw new AssertionError("Diagnostic changed original failure/cleanup");
        }
    }
    public static void main(String[] args) {
        System.load(args[0]);
        ArtPlatform.initializeRpc(Integer.parseInt(args[2]));
        android.util.Log.d("GmsHttpFormClient","CONTROL_DEBUG_AFTER_VM");
        android.util.Log.w("LogInitControl","CONTROL_WARNING_AFTER_VM");
        System.load(args[1]);
        int result=probe();
        if(result!=0)throw new AssertionError("Original ART redirected logging failed: "+result);
        System.out.println("PASS original ART post-VM logger retains physical destination after guest dup2/close");
    }
}
