package maclauncher.android.bridge;
import android.content.pm.ApplicationInfo;
import maclauncher.android.framework.HostContext;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
public final class StartupBindingProbe {
    private static native boolean inspect(String core);
    private static void field(String name,Object value)throws Exception{var f=HostContext.class.getDeclaredField(name);f.setAccessible(true);f.set(null,value);}
    public static void main(String[] args)throws Exception{
        String core=Path.of(args[0]).toRealPath().toString(),root=Path.of(args[3]).toRealPath().toString();
        System.load(core);System.load(Path.of(args[1]).toRealPath().toString());System.load(Path.of(args[2]).toRealPath().toString());
        ApplicationInfo info=new ApplicationInfo();info.targetSdkVersion=35;field("application",info);field("packageName","startup.owner");field("processName","startup.owner:worker");
        byte[] runtime=core.getBytes(StandardCharsets.UTF_8),directory=root.getBytes(StandardCharsets.UTF_8);
        if(args[4].equals("missing")){
            try{NativeBinding.configureRuntime(runtime,directory);throw new AssertionError("Missing startup packet accepted");}catch(IllegalStateException expected){}
            System.out.println("PASS missing startup packet rejects JNI configuration");return;
        }
        NativeBinding.configureRuntime(runtime,directory);if(!inspect(core))throw new AssertionError("Native startup differs");
        NativeBinding.configureRuntime(runtime,directory);
        field("processName","startup.owner:changed");
        try{NativeBinding.configureRuntime(runtime,directory);throw new AssertionError("Changed startup accepted");}catch(IllegalStateException expected){}
        if(!inspect(core))throw new AssertionError("Rejected configuration changed native startup");
        System.out.println("PASS actual HostContext to JNI startup, standard UTF8 and immutable identity");
    }
}
