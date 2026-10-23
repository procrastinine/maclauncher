package maclauncher.android.fixture;

import android.app.Application;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.*;
import java.nio.file.*;
import java.util.List;
import maclauncher.android.framework.*;
import com.android.server.appwidget.HostWidgetService;

public final class WidgetServiceProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
    static void run(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Path.of(args[1]),framework=runtime.resolve("android-framework.jar");
        Looper loop=RuntimeFixture.initialize(args[0],args[1]);
        HostProcessIdentity.configure(android.os.Process.SYSTEM_UID,android.system.Os.getuid());
        try(var system=HostSystemServices.start(runtime,data,"android.system")){
            Context context=HostApplication.applicationContext();
            var field=HostSystemServices.class.getDeclaredField("widgets");field.setAccessible(true);
            check(field.get(system)==null,"widget owner starts only when requested");
            check(java.util.Arrays.asList(HostServices.publishedManager().listServices(0)).contains(Context.APPWIDGET_SERVICE),"shared directory declares lazy service without constructing it");
            check(field.get(system)==null,"listing keeps service lazy");
            check(HostServices.publishedManager().checkService(Context.APPWIDGET_SERVICE)!=null,"shared directory starts the original service for an application client");
            var manager=context.getSystemService(AppWidgetManager.class);
            check(manager!=null,"original registry constructs AppWidgetManager");
            var owner=(HostWidgetService)field.get(system);
            check(owner.getClass().getSuperclass().getName().equals("com.android.server.appwidget.AppWidgetServiceImpl"),"original service owns widget behavior");
            check(manager.getAppWidgetIds(new ComponentName("android","NoInstalledWidget")).length==0,"original unbound provider result");
            check(manager.getInstalledProviders().isEmpty(),"original provider enumeration");
            check(owner.getMaxBitmapMemory()>0,"original display bitmap budget");
        }finally{HostApplication.shutdown();HostLooper.close(loop);FrameworkResources.shutdown();}
        check(com.android.server.LocalServices.getService(android.appwidget.AppWidgetManagerInternal.class)==null,"local service ownership retired");
        System.out.println("PASS original widget service and AppWidgetManager: provider queries, empty bindings and lifecycle");
    }
}
