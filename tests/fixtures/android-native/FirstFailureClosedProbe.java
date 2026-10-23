package maclauncher.android;

public final class FirstFailureClosedProbe {
    private static native int closeStderr();
    public static void main(String[] args) {
        maclauncher.android.test.NativeResourceSupport.resources();
        android.util.Log.i("FirstFailureProbe", "original logging initialized");
        System.load(args[0]);
        if(closeStderr()!=0)throw new AssertionError("Guest stderr close failed");
        IllegalStateException original=new IllegalStateException("original JVM failure after guest stderr close");
        boolean cleanup=false;
        try {
            try {throw original;}
            catch(IllegalStateException failure){FirstFailure.reportOwner(failure);throw failure;}
            finally{cleanup=true;}
        }catch(IllegalStateException failure){
            if(failure!=original||!cleanup)throw new AssertionError("Diagnostic changed original throwable/cleanup");
        }
        System.out.println("PASS original JVM Android logger retains failure after guest stderr close");
        System.exit(0);
    }
}
