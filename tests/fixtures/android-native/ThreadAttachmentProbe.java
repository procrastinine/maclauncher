public final class ThreadAttachmentProbe {
    private static native int run(String library,String identities);
    private static native void beginManaged(boolean unwrapped,int nested);
    private static native void depart();
    private static native int nativeStatus();
    private static native int retired();
    private static native void halt();
    private static void bridge(){depart();}
    public static void main(String[] arguments)throws Exception {
        System.load(arguments[0]);
        int retained=run(arguments[1],arguments[2]);
        System.out.println("guest JVM attachments retained="+retained);
        if(retained!=0)throw new AssertionError("Guest attachment retained");
        if(arguments.length>3){
            boolean negative=arguments[3].equals("unwrapped");
            for(int nested=0;nested<(negative?1:3);nested++){
                beginManaged(negative,nested);
                var death=new java.util.concurrent.atomic.AtomicBoolean();
                Thread worker=new Thread(ThreadAttachmentProbe::depart,"managed-exit-probe-"+nested);
                worker.setUncaughtExceptionHandler((thread,error)->death.set(error instanceof ThreadDeath));
                worker.start();worker.join(250);
                long deadline=System.nanoTime()+250_000_000L;
                while(nativeStatus()==0&&System.nanoTime()<deadline)Thread.onSpinWait();
                if(negative){
                    if(!worker.isAlive()||nativeStatus()!=3)throw new AssertionError("Unwrapped native exit did not reproduce stale attachment");
                    System.out.println("negative stale JVM attachment reproduced");halt();
                }
                if(worker.isAlive()||!death.get()||nativeStatus()!=3||retired()!=nested+1)
                    throw new AssertionError("VM did not own managed retirement: alive="+worker.isAlive()+" death="+death+" native="+nativeStatus()+" retired="+retired());
            }
            System.out.println("managed exits=3 retired="+retired());
        }
        System.exit(retained==0?0:1);
    }
}
