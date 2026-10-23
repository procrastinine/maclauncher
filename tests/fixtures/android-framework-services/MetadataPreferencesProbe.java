package android.content.res;

import android.content.*;
import android.content.pm.*;
import android.preference.PreferenceManager;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;

/** Owned compiled XML through original package resources and ContextImpl preferences. */
public final class MetadataPreferencesProbe {
    static void check(boolean value,String reason){if(!value)throw new AssertionError(reason);}
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]).toRealPath(),root=Path.of(args[1]).toRealPath();
        var loop=maclauncher.android.fixture.RuntimeFixture.initialize(args[0],args[1]);
        byte[] xml=CompiledXmlFixtures.document(true,
            CompiledXmlFixtures.start(6,CompiledXmlFixtures.attr(3,3,9),CompiledXmlFixtures.attr(4,0x12,1)),CompiledXmlFixtures.end(6));
        Path apk=CompiledXmlFixtures.apk(root,"resources.apk","res/xml/preferences.xml",xml);
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
        HostContext.hostPackage("owned.preferences","1",1);
        HostContext.hostApplicationInfo(false,apk.toString(),root.toString(),root.toString(),28);
        HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
        HostStorageService.install();HostApplication.prepare(MetadataPreferencesProbe.class.getClassLoader());
        var context=HostApplication.applicationContext();
        var application=new android.app.Application();HostApplication.attach(application,context);
        try{
        check(context.getClass().getName().equals("android.app.ContextImpl"),"original storage owner");
        var manager=context.getPackageManager();
        var provider=new ProviderInfo();provider.packageName="owned.preferences";
        provider.applicationInfo=context.getApplicationInfo();
        check(provider.loadXmlMetaData(manager,"paths")==null,"absent metadata");
        provider.metaData=new android.os.Bundle();provider.metaData.putInt("paths",0x7f010000);
        try(var parser=provider.loadXmlMetaData(manager,"paths")){
            check(parser!=null,"actual compiled XML opened");
            int event;do{event=parser.next();}while(event!=2&&event!=1);
            check(event==2&&parser.getName().equals("PreferenceScreen"),"actual XML root");
            check(parser.nextTag()==2&&parser.getName().equals("SwitchPreference"),"actual XML contents");
        }
        var copy=new ProviderInfo(provider);copy.metaData=new android.os.Bundle(provider.metaData);copy.metaData.putInt("paths",0x7fffffff);
        check(copy.loadXmlMetaData(manager,"paths")==null,"missing resource returns null");
        check(provider.metaData.getInt("paths")==0x7f010000,"copied metadata is independent");
        check(manager.getXml("uninstalled.package",0x7f010000,null)==null,"unavailable package has no resource");
        var prefs=PreferenceManager.getDefaultSharedPreferences(context);
        check(prefs==context.getSharedPreferences("owned.preferences_preferences",0),"same Context store and conventional name");
        prefs.edit().putString("test_string","saved").commit();
        PreferenceManager.setDefaultValues(context,0x7f010000,false);
        check(prefs.getBoolean("test_boolean",false)&&prefs.getString("test_string",null).equals("saved"),"defaults preserve choices");
        prefs.edit().remove("test_boolean").commit();PreferenceManager.setDefaultValues(context,0x7f010000,false);
        check(!prefs.contains("test_boolean"),"persisted initialization marker");
        PreferenceManager.setDefaultValues(context,0x7f010000,true);
        check(prefs.getBoolean("test_boolean",false)&&prefs.getString("test_string",null).equals("saved"),"readAgain fills missing only");
        context.getSharedPreferences(PreferenceManager.KEY_HAS_SET_DEFAULT_VALUES,0).edit().clear().commit();
        try{PreferenceManager.setDefaultValues(context,0x7fffffff,false);throw new AssertionError("missing defaults accepted");}catch(Resources.NotFoundException expected){}
        check(!context.getSharedPreferences(PreferenceManager.KEY_HAS_SET_DEFAULT_VALUES,0).getBoolean(PreferenceManager.KEY_HAS_SET_DEFAULT_VALUES,false),"failed resource not marked initialized");
        }finally{
            android.app.QueuedWork.waitToFinish();android.app.QueuedWork.resetHandler();
            // The application process normally exits after host teardown. This standalone
            // fixture joins the upstream process-scoped loader so JVM exit is observable.
            var field=Class.forName("android.app.SharedPreferencesImpl").getDeclaredField("sLoadExecutor");field.setAccessible(true);
            var executor=(java.util.concurrent.ExecutorService)field.get(null);executor.shutdown();
            check(executor.awaitTermination(2,java.util.concurrent.TimeUnit.SECONDS),"preference loader retired");
            HostApplication.shutdown();FrameworkResources.shutdown();HostLooper.close(loop);
        }
        System.out.println("PASS metadata XML ownership, absence and preference Context routing/defaults");
    }
}
