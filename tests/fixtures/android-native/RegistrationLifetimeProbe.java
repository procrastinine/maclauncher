public final class RegistrationLifetimeProbe {
    private static native long attempt(int stage,Throwable pending);
    private static native long live();
    private static native long aborts();
    private static native boolean usable();
    private static native boolean ownerUsable();
    private static native boolean classified();
    private static void check(boolean value){if(!value)throw new AssertionError();}
    private static void pending(){
        var original=new IllegalArgumentException("original exception");
        try{attempt(0,original);throw new AssertionError();}catch(IllegalArgumentException actual){check(actual==original);}
    }
    public static void main(String[] args){
        System.load(args[0]);pending();check(live()==0&&!classified());
        // Fail GetJNIFunctionTable, the acquired-table path and table publication
        // independently in the bootstrap and subsequent guest-hook stages.
        for(int stage=1;stage<=6;++stage){
            try{attempt(stage,null);throw new AssertionError("Fault was not injected: "+stage);}catch(IllegalStateException expected){}
            check(live()==1&&ownerUsable()&&!usable()&&!classified());
            check(aborts()==Math.max(0,stage-3));
        }
        check(attempt(0,null)==1&&live()==1&&usable()&&classified());
        check(attempt(0,null)==1&&live()==1&&usable());pending();check(live()==1&&usable());
        System.out.println("PASS registration lifetime: failed hooks publish no ranges and retain one usable VM owner");
    }
}
