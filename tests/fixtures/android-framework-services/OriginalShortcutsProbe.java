import android.app.Application;
import android.content.*;
import android.content.pm.*;
import android.graphics.Bitmap;
import android.graphics.drawable.Icon;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;

public final class OriginalShortcutsProbe {
    static final String PACKAGE="org.maclauncher.metadata.fixture";
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static void usageRecorded()throws Exception{
        var type=com.android.server.usage.HostUsageEvents.class;var ownerField=type.getDeclaredField("current");ownerField.setAccessible(true);
        var originalField=type.getDeclaredField("original");originalField.setAccessible(true);var original=originalField.get(ownerField.get(null));
        var query=original.getClass().getDeclaredMethod("queryEvents",long.class,long.class,int.class,int[].class,android.util.ArraySet.class);query.setAccessible(true);
        var events=(android.app.usage.UsageEvents)query.invoke(original,0L,System.currentTimeMillis()+1,0,new int[]{android.app.usage.UsageEvents.Event.SHORTCUT_INVOCATION},null);
        boolean found=false;if(events!=null){var event=new android.app.usage.UsageEvents.Event();while(events.getNextEvent(event))if(PACKAGE.equals(event.getPackageName())&&"persist".equals(event.getShortcutId()))found=true;}
        check(found,"original usage-event database retains shortcut invocation");
    }
    public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
    static void run(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Path.of(args[1]),framework=runtime.resolve("android-framework.jar");
        var loop=RuntimeFixture.initialize(args[0],args[1]);HostProcessIdentity.configure(1000,android.system.Os.getuid());
        FrameworkResources.configure(framework,List.of(framework));HostContext.hostPackage("android","16",1);
        HostContext.hostApplicationInfo(0,framework.toString(),data.toString(),runtime.resolve("native").toString(),0);HostContext.hostApplicationIdentity(1000,0);
        HostPackages.inspectSources(List.of(framework));
        var installed=new org.json.JSONObject().put("packageName",PACKAGE).put("sourceApks",new org.json.JSONArray().put(data.resolve("app.apk").toString()))
            .put("dataRoot",data.resolve("application").toString()).put("nativeRoot",data.resolve("application").toString()).put("uid",12000).put("firstInstallTime",1).put("lastUpdateTime",1);
        HostPackages.inspectInstalled(new org.json.JSONArray().put(installed).toString());HostStorageService.install();HostApplication.prepare(OriginalShortcutsProbe.class.getClassLoader());
        var context=HostApplication.applicationContext();HostApplication.attach(new Application(),context);
        var stats=new HostStats(context);stats.ready();HostUriGrants.start(context);
        var processes=new HostProcessServices();var processInfo=new HostProcessInfo(context,processes);
        HostShortcuts.start(context);
        var endpoint=ServiceManager.getService(Context.SHORTCUT_SERVICE);check(endpoint!=null,"original shortcut endpoint published");
        var pair=ParcelFileDescriptor.createSocketPair();
        var app=new HostBinderRpc.Peer(PACKAGE,PACKAGE,android.os.Process.myPid(),12000);
        processes.expect(app);processes.processState(app,android.app.ActivityManager.PROCESS_STATE_CACHED_EMPTY);
        var system=new HostBinderRpc.Peer("android","android",android.os.Process.myPid(),1000);
        try(var server=HostBinderRpc.serve(pair[0],app,endpoint,2);var client=HostBinderRpc.connect(pair[1],system,2)){
            var remote=IShortcutService.Stub.asInterface(client.root());
            var appContext=new ContextWrapper(context){@Override public String getPackageName(){return PACKAGE;}};
            var manager=new ShortcutManager(appContext,remote);
            check(manager.getMaxShortcutCountPerActivity()==15,"original configured per-activity limit");
            check(!manager.isRequestPinShortcutSupported(),"no Android HOME-role owner means original pinning is unsupported");
            if(args.length>2){
                usageRecorded();
                var saved=manager.getDynamicShortcuts();check(saved.size()==1&&saved.get(0).getId().equals("persist")&&saved.get(0).hasIconFile(),"original shortcut XML and bitmap restore across owner process");
                manager.removeAllDynamicShortcuts();check(manager.getDynamicShortcuts().isEmpty(),"original restored deletion");
            }else{
                try{remote.getShortcuts("other.package",ShortcutManager.FLAG_MATCH_DYNAMIC,0);throw new AssertionError("cross-package read allowed");}catch(SecurityException expected){}
                int icon=HostPackages.service().getApplicationInfo(PACKAGE,0,0).icon;
                var shortcut=new ShortcutInfo.Builder(appContext,"persist").setShortLabel("Original shortcut").setIntent(new Intent(Intent.ACTION_VIEW,android.net.Uri.parse("https://example.invalid/shortcut"))).setIcon(Icon.createWithResource(PACKAGE,icon)).build();
                check(manager.setDynamicShortcuts(List.of(shortcut)),"original dynamic publication");
                check(manager.getDynamicShortcuts().size()==1,"original dynamic query");
                var update=new ShortcutInfo.Builder(appContext,"persist").setShortLabel("Updated").build();check(manager.updateShortcuts(List.of(update)),"original update");
                check(manager.getDynamicShortcuts().get(0).getShortLabel().toString().equals("Updated"),"updated original value");
                manager.reportShortcutUsed("persist");
                usageRecorded();
                int remaining=manager.getRemainingCallCount();check(remaining==8,"original ten-call quota accounts for set and update");
                for(int i=0;i<remaining;i++)check(manager.updateShortcuts(List.of(update)),"original remaining quota");
                check(!manager.updateShortcuts(List.of(update)),"original throttle rejects exhausted mutation");
                processes.processState(app,android.app.ActivityManager.PROCESS_STATE_TOP);HostLooper.drain(loop);
                processes.processState(app,android.app.ActivityManager.PROCESS_STATE_CACHED_EMPTY);HostLooper.drain(loop);
                long deadline=System.nanoTime()+2_000_000_000L;
                while(manager.getRemainingCallCount()!=10&&System.nanoTime()<deadline)Thread.sleep(5);
                check(manager.getRemainingCallCount()==10&&manager.updateShortcuts(List.of(update)),"actual shared foreground transition resets original quota");
                try{remote.resetThrottling();throw new AssertionError("ordinary caller reset throttle");}catch(SecurityException expected){}
            }
        }finally{pair[0].close();pair[1].close();}
        if(args.length==2){
            var bitmap=Bitmap.createBitmap(8,8,Bitmap.Config.ARGB_8888);bitmap.eraseColor(0xff2170cc);
            var appContext=new ContextWrapper(context){@Override public String getPackageName(){return PACKAGE;}};
            var update=new ShortcutInfo.Builder(appContext,"persist").setIcon(Icon.createWithBitmap(bitmap)).build();
            check(IShortcutService.Stub.asInterface(endpoint).updateShortcuts(PACKAGE,new ParceledListSlice<>(List.of(update)),0),"original bitmap save path");
        }
        processes.unavailable(app);HostLooper.drain(loop);processInfo.close();processes.close();
        HostApplication.shutdown();HostLooper.close(loop);stats.close();FrameworkResources.shutdown();
        check(HostServices.manager().checkService(Context.SHORTCUT_SERVICE)==null,"shortcut endpoint retired");
        System.out.println("PASS original ShortcutManager/RPC: package permissions, quotas, update, icons, usage, persistence and retirement");
    }
}
