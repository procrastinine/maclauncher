package maclauncher.android;

import java.nio.file.*;
import maclauncher.android.framework.*;
import android.provider.Settings;
import android.content.*;
import android.os.*;

public final class OriginalSettingsProviderProbe {
 public static void main(String[] args)throws Exception {
  try{run(args);System.exit(0);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}
 }
 private static void run(String[] args)throws Exception {
  Path runtime=Path.of(args[0]).toRealPath(),data=Path.of(args[1]);
  Files.createDirectories(data.resolve("files"));Files.createDirectories(data.resolve("cache"));
  RuntimeBootstrap.initialize(runtime,data,data.resolve("files"),data.resolve("cache"),"android",false,false,false);
  HostProcessIdentity.configure(1000,Integer.parseInt(args[2]));HostContext.hostBootCount(7);
  Looper loop=HostLooper.main();
  try(var owner=HostSystemServices.start(runtime,data,"android.system")){
   Context context=HostApplication.applicationContext();var resolver=context.getContentResolver();
   var info=context.getPackageManager().resolveContentProvider("settings",0);
   if(info==null||!info.name.equals("com.android.providers.settings.SettingsProvider"))throw new AssertionError("Original provider not discovered");
   PlatformProviderDemandProbe.prepare(context,info);
   String key="screen_brightness";
   try(var client=resolver.acquireContentProviderClient("settings")){
    if(args.length<4){
     ContentValues values=new ContentValues();values.put("name",key);values.put("value","121");
     if(client.insert(Settings.System.CONTENT_URI,values)==null)throw new AssertionError("Original insert failed");
     values.put("value","122");
     if(client.update(Settings.System.CONTENT_URI,values,"name=?",new String[]{key})!=1)throw new AssertionError("Original update failed");
     if(!"122".equals(Settings.System.getString(resolver,key)))throw new AssertionError("Original generation did not update");
     if(client.delete(Settings.System.CONTENT_URI,"name=?",new String[]{key})!=1)throw new AssertionError("Original delete failed");
     if(Settings.System.getString(resolver,key)!=null)throw new AssertionError("Deleted value remained cached");
     if(!Settings.System.putString(resolver,key,"123"))throw new AssertionError("Original Settings write failed");
     if(!Settings.Global.putInt(resolver,"adb_enabled",0)||Settings.System.getInt(resolver,"adb_enabled",-1)!=0)throw new AssertionError("Original moved setting read failed");
     if(Settings.System.putInt(resolver,"adb_enabled",1)||Settings.Global.getInt(resolver,"adb_enabled",-1)!=0)throw new AssertionError("Moved setting write did not retain Android's read-only alias");
    }
    if(!"123".equals(Settings.System.getString(resolver,key)))throw new AssertionError("Original provider read/persistence failed");
    if(Settings.Global.getInt(resolver,Settings.Global.BOOT_COUNT,-1)!=7)throw new AssertionError("Authenticated boot count differs");
    String type=client.getType(Settings.System.CONTENT_URI);
    if(!"vnd.android.cursor.dir/system".equals(type))throw new AssertionError(type);
    try(var cursor=client.query(Settings.System.CONTENT_URI,new String[]{"name","value"},"name=?",new String[]{key},null)){
     if(cursor==null||!cursor.moveToFirst()||!"123".equals(cursor.getString(1)))throw new AssertionError("Original query failed");
    }
   }
   Thread.sleep(350);
   System.out.println("PASS original settings provider CRUD, aliases, generations and persistence");
  }finally{HostApplication.shutdown();HostLooper.close(loop);}
 }
}
