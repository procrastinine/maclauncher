import android.content.*;
import android.content.pm.ApplicationInfo;
import android.database.ContentObserver;
import android.net.Uri;
import android.os.*;
import maclauncher.android.framework.*;
import java.nio.file.*;
import java.util.*;

/** Public AOSP resolver APIs, original observer tree, and real local Binder dispatch. */
public final class NativeContentServiceProbe {
    public static final class RetainedProvider extends ContentProvider {
        private boolean retired;
        @Override public boolean onCreate(){return true;}
        @Override public void shutdown(){retired=true;}
        @Override public Bundle call(String method,String argument,Bundle extras){if(retired)throw new AssertionError("Borrower retired ActivityThread's provider");Bundle result=new Bundle();result.putString("owner","ActivityThread");return result;}
        @Override public android.database.Cursor query(Uri uri,String[] projection,String selection,String[] args,String order){return null;}
        @Override public String getType(Uri uri){return null;}
        @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
        @Override public int delete(Uri uri,String selection,String[] args){throw new UnsupportedOperationException();}
        @Override public int update(Uri uri,ContentValues values,String selection,String[] args){throw new UnsupportedOperationException();}
    }
    private static int checks;
    private static void check(boolean value){check(value,"check "+checks);}
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);checks++;}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]).toRealPath(),data=Path.of(args[1]).toRealPath(),apk=data.resolve("owned.apk");
        try(var output=new java.util.zip.ZipOutputStream(Files.newOutputStream(apk))){output.putNextEntry(new java.util.zip.ZipEntry("assets/owned.txt"));output.write(1);output.closeEntry();}
        HostFilesystem.configure(runtime,data,data,data,"owned.content");
        System.setProperty("klepton.bridge",runtime.resolve("native/libklepton-jvm.dylib").toString());
        System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
        System.setProperty("klepton.audio",runtime.resolve("native/libklepton-audio.dylib").toString());
        System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(runtime.resolve("native/libnativebinding.dylib").toString());
        HostProcessIdentity.initializeIds();
        JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
        HostProcessIdentity.configure(10001,(int)new com.sun.security.auth.module.UnixSystem().getUid());
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
        HostContext.hostPackage("owned.content","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),36);HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
        Looper loop=HostLooper.main();HostStorageService.install();HostApplication.prepare(NativeContentServiceProbe.class.getClassLoader());
        Context context=HostApplication.applicationContext();var application=new android.app.Application();HostApplication.attach(application,context);
        var info=new android.content.pm.ProviderInfo();info.packageName=context.getPackageName();info.name=RetainedProvider.class.getName();info.authority="owned.retained";info.enabled=true;info.applicationInfo=context.getApplicationInfo();
        var providers=new maclauncher.android.LocalProviders();providers.install(context,List.of(info));
        var service=Objects.requireNonNull(IContentService.Stub.asInterface(ServiceManager.getService("content")),"Original content service is not ready");
        {
            check(ServiceManager.getService("content")!=null);
            check(ServiceManager.checkService("absent.content.fixture")==null);
            var resolver=context.getContentResolver();var events=new ArrayList<Uri>();
            check(resolver.getClass().getName().equals("android.app.ContextImpl$ApplicationContentResolver"));
            var observer=new ContentObserver(null){@Override public void onChange(boolean self,Uri uri){events.add(uri);}};
            Uri root=Uri.parse("content://owned.content/items"),child=Uri.parse("content://owned.content/items/7");
            resolver.registerContentObserver(root,true,observer);
            resolver.notifyChange(child,null,ContentResolver.NOTIFY_NO_DELAY|ContentResolver.NOTIFY_INSERT);
            check(events.equals(List.of(child)));events.clear();
            resolver.notifyChange(Uri.parse("content://other/items/7"),null,ContentResolver.NOTIFY_NO_DELAY);check(events.isEmpty());
            resolver.notifyChange(child,observer,ContentResolver.NOTIFY_NO_DELAY);check(events.isEmpty());
            resolver.unregisterContentObserver(observer);
            resolver.notifyChange(child,null,ContentResolver.NOTIFY_NO_DELAY);check(events.isEmpty());
            resolver.registerContentObserver(root,false,observer);
            resolver.notifyChange(child,null,ContentResolver.NOTIFY_NO_DELAY);check(events.isEmpty());
            resolver.notifyChange(root,null,ContentResolver.NOTIFY_NO_DELAY);check(events.equals(List.of(root)));
            resolver.unregisterContentObserver(observer);
            Bundle cached=new Bundle();cached.putString("key","before");resolver.putCache(root,cached);cached.putString("key","after");
            check(resolver.getCache(root).getString("key").equals("before"));resolver.notifyChange(root,null,ContentResolver.NOTIFY_NO_DELAY);check(resolver.getCache(root)==null);
            check(resolver.acquireContentProviderClient("missing.authority")==null);
        }
        try(var retained=context.getContentResolver().acquireContentProviderClient(info.authority)){
            check(retained!=null);providers.close();providers.close();
            check(retained.call("alive",null,null).getString("owner").equals("ActivityThread"));
            try(var reacquired=context.getContentResolver().acquireContentProviderClient(info.authority)){check(reacquired!=null&&reacquired.call("alive",null,null).getString("owner").equals("ActivityThread"));}
        }
        var endpoint=new Binder("owned.binder"){
            @Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException{
                if(code!=FIRST_CALL_TRANSACTION)return super.onTransact(code,data,reply,flags);
                data.enforceInterface("owned.binder");reply.writeNoException();reply.writeInt(data.readInt()+1);return true;
            }
        };
        Parcel request=Parcel.obtain(),reply=Parcel.obtain();
        try{request.writeInterfaceToken("owned.binder");request.writeInt(41);check(endpoint.transact(IBinder.FIRST_CALL_TRANSACTION,request,reply,0));reply.readException();check(reply.readInt()==42);}
        finally{request.recycle();reply.recycle();}
        var extension=new Binder("owned.extension");endpoint.setExtension(extension);check(endpoint.getExtension()==extension);
        check(Binder.getCallingPid()==android.os.Process.myPid(),"Binder caller PID before clear differs from Android process PID");
        long identity=Binder.clearCallingIdentity();
        check(Binder.getCallingPid()==android.os.Process.myPid(),"Cleared Binder caller PID differs from Android process PID");
        check(Binder.getCallingUidOrThrow()==android.os.Process.myUid());Binder.restoreCallingIdentity(identity);
        check(Binder.getCallingPid()==android.os.Process.myPid(),"Restored local Binder caller PID differs from Android process PID");
        Binder.setThreadStrictModePolicy(17);check(Binder.getThreadStrictModePolicy()==17);Binder.setThreadStrictModePolicy(0);
        long source=Binder.setCallingWorkSourceUid(23);check(Binder.getCallingWorkSourceUid()==23);Binder.restoreCallingWorkSource(source);check(Binder.getCallingWorkSourceUid()==-1);
        int callingPid=Binder.getCallingPid(),processPid=android.os.Process.myPid();
        check(callingPid==processPid,"Binder caller PID "+callingPid+" differs from Android process PID "+processPid);
        HostApplication.shutdown();HostLooper.close(loop);FrameworkResources.shutdown();
        System.out.println("PASS "+checks+" raw AOSP content observers, resolver service lookup and Binder transactions");
    }
}
