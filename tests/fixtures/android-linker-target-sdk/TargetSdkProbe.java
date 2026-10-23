package maclauncher.android.bridge;
import android.content.pm.ApplicationInfo;
import maclauncher.android.framework.HostContext;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

public final class TargetSdkProbe {
    private static native int acceptSdk(String runtime,int sdk);
    private static void application(Integer sdk)throws Exception {
        var field=HostContext.class.getDeclaredField("application");field.setAccessible(true);
        ApplicationInfo value=sdk==null?null:new ApplicationInfo();if(value!=null)value.targetSdkVersion=sdk;
        field.set(null,value);
    }
    private static void configure(String runtime,String root){NativeBinding.configureRuntime(runtime.getBytes(StandardCharsets.UTF_8),root.getBytes(StandardCharsets.UTF_8));}
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception {
        String core=Path.of(args[0]).toRealPath().toString(),root=Path.of(args[3]).toRealPath().toString();
        System.load(core);System.load(Path.of(args[1]).toRealPath().toString());System.load(Path.of(args[2]).toRealPath().toString());
        for(Integer absent:new Integer[]{null,0}){
            application(absent);
            try{HostContext.hostApplicationTargetSdkVersion();throw new AssertionError("Unconfigured target SDK was accepted");}catch(IllegalStateException expected){}
            try{configure(core,root);throw new AssertionError("Native runtime accepted absent target SDK");}catch(IllegalStateException expected){}
        }
        application(22);check(HostContext.hostApplicationTargetSdkVersion()==22,"Original ApplicationInfo target SDK differs");
        configure(core,root);
        check(acceptSdk(core,23)==0,"JNI configuration did not publish the inspected target SDK before loading");
        check(acceptSdk(core,22)==1,"Actual target SDK was not retained");configure(core,root);
        application(23);
        try{configure(core,root);throw new AssertionError("Runtime accepted a different application target SDK");}catch(IllegalStateException expected){}
        check(acceptSdk(core,22)==1,"Rejected reconfiguration changed original linker policy");
        System.out.println("PASS actual ApplicationInfo target SDK before native image configuration, repeated identity and rejected changes");
    }
}
