import java.nio.file.Path;
import maclauncher.android.bridge.NativeBinding;

public final class StackSimdProbe {
    private static native int execute();
    public static void main(String[] args)throws Exception {
        Path core=Path.of(args[0]),binding=Path.of(args[1]),guest=Path.of(args[2]);
        System.load(core.toString());System.load(binding.toString());
        maclauncher.android.framework.HostProcessIdentity.initializeIds();
        long image=NativeBinding.load(core.toString(),guest.toString(),"libstack-simd.so");
        NativeBinding.bind(image,StackSimdProbe.class);
        if(execute()!=4)throw new AssertionError("Original ELF SIMD/SP execution");
        Thread worker=new Thread(()->{if(execute()!=4)throw new AssertionError("Fresh native thread");});
        worker.setUncaughtExceptionHandler((thread,error)->{error.printStackTrace();System.exit(1);});
        worker.start();worker.join(5000);if(worker.isAlive())throw new AssertionError("Native thread did not retire");
        System.out.println("PASS live JVM original ELF SIMD/SP veneers preserve scratch, flags and the native signal owner");
    }
}
