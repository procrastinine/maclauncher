package maclauncher.android;

import android.app.*;
import android.content.*;
import android.content.pm.*;
import android.content.res.Configuration;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;

/** Real original ContextImpl storage, identity, client factories and dispatcher integration. */
public final class ContextCoreProbe {
    private static int checks;
    private static void check(boolean value,String message){checks++;if(!value)throw new AssertionError(message);}
    private static void architecture()throws Exception{
        check(HostContext.class.getSuperclass()==Object.class,"package metadata does not implement Context APIs");
        Set<String> upstream=new HashSet<>();for(var method:Context.class.getDeclaredMethods())upstream.add(method.getName()+Arrays.toString(method.getParameterTypes()));
        for(var method:HostContext.class.getDeclaredMethods())check(!upstream.contains(method.getName()+Arrays.toString(method.getParameterTypes())),"no local Context API replacement: "+method);
        check(HostWindowManager.class.getSuperclass()==Object.class&&HostActivityManager.class.getSuperclass()==Object.class,"platform owners do not replace concrete manager clients");
        for(String name:List.of("HostConnectivityManager","HostTrafficStats","HostSharedPreferences","HostViewRoot","HostCanvas","HostEditable","HostInsetsController"))try{Class.forName("maclauncher.android.framework."+name,false,ContextCoreProbe.class.getClassLoader());throw new AssertionError("Obsolete alternate framework remains: "+name);}catch(ClassNotFoundException expected){}
    }
    public static void main(String[] args)throws Exception{
        architecture();
        Path runtime=Path.of(args[0]).toRealPath(),data=Files.createDirectories(Path.of(args[1])).toRealPath();
        Path files=Files.createDirectories(data.resolve("files")),cache=Files.createDirectories(data.resolve("cache"));
        HostFilesystem.configure(runtime,data,files,cache,"org.example.window");
        System.setProperty("klepton.bridge",runtime.resolve("native/libklepton-jvm.dylib").toString());System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());System.setProperty("klepton.audio",runtime.resolve("native/libklepton-audio.dylib").toString());
        System.load(System.getProperty("klepton.bridge"));System.load(runtime.resolve("native/libnativebinding.dylib").toString());JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();if(args.length>2)System.load(Path.of(args[2]).toAbsolutePath().toString());HostStorageService.install();
        Path apk=data.resolve("owned.apk");SyntheticResources.locales(apk,new String[]{"","fr"},new String[]{"Context","Contexte"});maclauncher.android.fixture.PackageManifest.add(apk,"window");FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
        HostContext.hostPackage("org.example.window","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostContext.hostFilesDirectory(files.toString());HostContext.hostCacheDirectory(cache.toString());ClassLoader guest=new ClassLoader(ContextCoreProbe.class.getClassLoader()){};HostContext.hostClassLoader(guest);HostPackages.inspectSources(List.of(apk));
        Looper loop=HostLooper.main();HostDisplay.hostPublish(1,320,240,60);HostApplication.prepare(guest);Context context=HostApplication.applicationContext();Application app=new Application();HostApplication.attach(app,context);HostApplication.create(app);
        try{
            check(context.getClass().getName().equals("android.app.ContextImpl"),"complete original ContextImpl");
            check(java.security.Security.getProvider("AndroidNSSP") instanceof android.security.net.config.NetworkSecurityConfigProvider,"original Android network security provider");
            check(javax.net.ssl.TrustManagerFactory.getInstance("PKIX").getProvider().getName().equals("AndroidNSSP"),"original manifest/domain trust policy owner");
            var trust=javax.net.ssl.TrustManagerFactory.getInstance("PKIX");trust.init((java.security.KeyStore)null);check(((javax.net.ssl.X509TrustManager)trust.getTrustManagers()[0]).getAcceptedIssuers().length>100,"original network policy loads supplied CA roots");
            check(context.getPackageManager().getClass().getName().equals("android.app.ApplicationPackageManager"),"complete original package client");
            check(context.getSystemService(ActivityManager.class).getClass()==ActivityManager.class,"complete original activity manager");
            check(context.getSystemService(android.view.WindowManager.class).getClass()==android.view.WindowManagerImpl.class,"complete original window manager");
            check(context.getApplicationContext()==app,"LoadedApk application identity");
            check(context.getResources().getClassLoader()==guest,"original LoadedApk resource class loader");
            check(context.getFilesDir().toPath().equals(files),"app-private files");check(context.getCacheDir().toPath().equals(cache),"app-private cache");
            Configuration locale=new Configuration(context.getResources().getConfiguration());locale.setLocale(Locale.FRENCH);
            Context configured=context.createConfigurationContext(locale);check(configured.getClass()==context.getClass()&&configured.isConfigurationContext(),"upstream configuration context");
            check(configured.getString(0x7f010000).equals("Contexte")&&context.getString(0x7f010000).equals("Context"),"original resource locale isolation");locale.setLocale(Locale.JAPANESE);
            check(configured.getResources().getConfiguration().getLocales().get(0).equals(Locale.FRENCH),"caller configuration copied");
            ContextWrapper wrapper=new ContextWrapper(configured);check(wrapper.getResources()==configured.getResources()&&wrapper.getFilesDir().equals(files.toFile()),"complete wrapper delegation");
            android.view.ContextThemeWrapper themed=new android.view.ContextThemeWrapper(context,android.R.style.Theme_Material_Light);try(var attributes=themed.obtainStyledAttributes(new int[]{android.R.attr.windowActionBar})){check(attributes.hasValue(0),"original themed attributes");}
            Context storage=context.createDeviceProtectedStorageContext();check(storage.getClass()==context.getClass()&&storage.isDeviceProtectedStorage()&&storage.getDataDir().toPath().startsWith(data),"upstream private storage context");
            Context packageContext=context.createPackageContext(context.getPackageName(),Context.CONTEXT_INCLUDE_CODE);check(packageContext.getClass()==context.getClass()&&packageContext.getClassLoader()==guest,"upstream package context");
            check(context.getContentResolver().getClass().getName().equals("android.app.ContextImpl$ApplicationContentResolver"),"upstream provider client");
            check(context.checkSelfPermission("android.permission.ACCESS_FINE_LOCATION")==PackageManager.PERMISSION_DENIED,"no unsolicited location");
            PreferenceStringSetProbe.run(context);
            ProcessHistoryProbe.run(context);
            ImageProbe.run(context);
            maclauncher.android.tests.OptionalHardware.run(context);
            maclauncher.android.tests.IntentSenderProbe.run(context);
            maclauncher.android.tests.ShortcutServiceProbe.run(context);
            android.content.res.LayoutInflationProbe.run(context);
            android.view.inputmethod.TextInputProbe.run(context);
            TrafficStatsProbe.run();
            int[] delivered={0};BroadcastReceiver receiver=new BroadcastReceiver(){public void onReceive(Context owner,Intent intent){delivered[0]++;}};
            context.registerReceiver(receiver,new IntentFilter("org.example.CONTEXT"),Context.RECEIVER_NOT_EXPORTED);context.sendBroadcast(new Intent("org.example.CONTEXT"));HostLooper.drain(loop);check(delivered[0]==1,"raw LoadedApk receiver delivery");context.unregisterReceiver(receiver);
            int[] orderedResult={0};BroadcastReceiver orderedReceiver=new BroadcastReceiver(){public void onReceive(Context owner,Intent intent){setResultCode(getResultCode()+7);}};
            BroadcastReceiver resultReceiver=new BroadcastReceiver(){public void onReceive(Context owner,Intent intent){orderedResult[0]=getResultCode();}};
            context.registerReceiver(orderedReceiver,new IntentFilter("org.example.ORDERED"),Context.RECEIVER_NOT_EXPORTED);
            context.sendOrderedBroadcast(new Intent("org.example.ORDERED"),null,resultReceiver,null,5,null,null);HostLooper.drain(loop);
            check(orderedResult[0]==12,"original ordered receiver completion reaches result without timeout");context.unregisterReceiver(orderedReceiver);
            try(var output=context.openFileOutput("raw.txt",0)){output.write("native".getBytes(java.nio.charset.StandardCharsets.UTF_8));}try(var input=context.openFileInput("raw.txt")){check(new String(input.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8).equals("native"),"raw Context file algorithms");}
            try(var output=context.openFileOutput("raw.txt",Context.MODE_APPEND)){output.write(33);}check(context.fileList().length>0&&context.getFileStreamPath("raw.txt").length()==7,"original append and listing");
            check(context.getDir("owned",Context.MODE_PRIVATE).toPath().startsWith(data),"original named private directory");
            check(context.getNoBackupFilesDir().toPath().equals(data.resolve("no_backup")),"original backup-excluded directory");
            try{context.createPackageContext("absent.application",0);throw new AssertionError("foreign package accepted");}catch(PackageManager.NameNotFoundException expected){}
            check(context.deleteFile("raw.txt"),"raw file deletion");
        }finally{QueuedWork.waitToFinish();QueuedWork.resetHandler();HostApplication.shutdown();HostWindowManager.shutdown();HostDisplay.hostShutdown();HostDisplay.hostRemove();FrameworkResources.shutdown();HostLooper.close(loop);HostContext.hostShutdown();}
        System.out.println("PASS "+checks+" original ContextImpl, package/window clients, preferences, private storage and dispatcher checks");
    }
}
