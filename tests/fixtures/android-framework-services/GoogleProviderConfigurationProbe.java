package maclauncher.android.framework;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.net.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.DynamicDex;
import maclauncher.android.LocalProviders;
import maclauncher.android.fixture.RuntimeFixture;

/** Original installed settings provider owns opt-in defaults and explicit choices. */
public final class GoogleProviderConfigurationProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static IBinder billing(Context context,Path prepared)throws Exception{
        Path apk=prepared.resolve(Files.isRegularFile(prepared.resolve("base.apk"))?"base.apk":"source.apk");
        ClassLoader loader=HostDexFiles.application(prepared.resolve("converted.jar"),List.of(apk),prepared.resolve("input/lib/arm64-v8a"),GoogleProviderConfigurationProbe.class.getClassLoader());
        android.app.Service service=(android.app.Service)Class.forName("com.android.vending.billing.InAppBillingService",true,loader).getConstructor().newInstance();
        var attach=ContextWrapper.class.getDeclaredMethod("attachBaseContext",Context.class);attach.setAccessible(true);attach.invoke(service,context);
        return service.onBind(new Intent("com.android.vending.billing.InAppBillingService.BIND"));
    }
    static int billingSupport(IBinder service,String packageName)throws Exception{
        Parcel request=Parcel.obtain(),reply=Parcel.obtain();
        try{
            request.writeInterfaceToken("com.android.vending.billing.IInAppBillingService");request.writeInt(3);request.writeString(packageName);request.writeString("inapp");
            check(service.transact(IBinder.FIRST_CALL_TRANSACTION,request,reply,0),"original billing discovery transaction");reply.readException();return reply.readInt();
        }finally{request.recycle();reply.recycle();}
    }
    static void billingCallback(IBinder service,String packageName)throws Exception{
        List<Bundle> replies=new ArrayList<>();
        Binder callback=new Binder(){
            @Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException{
                if(code!=IBinder.FIRST_CALL_TRANSACTION)return super.onTransact(code,data,reply,flags);
                data.enforceInterface("com.android.vending.billing.IInAppBillingInitializeCallback");replies.add(data.readTypedObject(Bundle.CREATOR));reply.writeNoException();return true;
            }
        };
        Parcel request=Parcel.obtain(),reply=Parcel.obtain();
        try{
            request.writeInterfaceToken("com.android.vending.billing.IInAppBillingService");request.writeInt(3);request.writeString(packageName);request.writeTypedObject(new Bundle(),0);request.writeStrongBinder(callback);
            // Original AIDL assigns initialize=2100, relative to FIRST_CALL_TRANSACTION.
            check(service.transact(IBinder.FIRST_CALL_TRANSACTION+2100,request,reply,0),"original initialization transaction");reply.readException();
        }finally{request.recycle();reply.recycle();}
        check(replies.size()==1,"original initialization callback delivered once");
        check(replies.get(0).getInt("RESPONSE_CODE",-1)==0&&replies.get(0).getInt("BILLING_API_VERSION_KEY",-1)==3,"original initialization response");
    }
    public static void main(String[] args)throws Exception{
        try{run(args);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}
    }
    static void run(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Path.of(args[1]),prepared=Path.of(args[2]);
        Path apk=prepared.resolve(Files.isRegularFile(prepared.resolve("base.apk"))?"base.apk":"source.apk");
        Looper loop=RuntimeFixture.initialize(runtime.toString(),data.toString(),runtime.resolve("native/libklepton-graphics.dylib").toString());
        HostGoogleProviders.configure(true);HostContext.hostPackage("com.google.android.gms","fixture",1);
        HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),prepared.resolve("input/lib/arm64-v8a").toString(),28);
        HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
        var inspected=HostPackages.inspectSources(List.of(apk));HostStorageService.install();
        ClassLoader loader=HostDexFiles.application(prepared.resolve("converted.jar"),List.of(apk),prepared.resolve("input/lib/arm64-v8a"),GoogleProviderConfigurationProbe.class.getClassLoader());
        HostContext.hostClassLoader(loader);DynamicDex.configure(runtime,Files.createDirectories(data.resolve("cache")),prepared.resolve("converted.jar"),loader);
        HostApplication.prepare(loader);Context context=HostApplication.applicationContext();
        Application app=new Application();HostApplication.attach(app,context);
        var policy=context.getSystemService(android.app.admin.DevicePolicyManager.class);
        check(policy!=null,"original device policy client is available without an Android administrator");
        check(policy.getAccountTypesWithManagementDisabled()==null,"original absent-administrator account policy");
        Class<?> contract=Class.forName("org.microg.gms.settings.SettingsContract$Vending",true,loader);
        String split=(String)contract.getField("SPLIT_INSTALL").get(null);
        android.preference.PreferenceManager.getDefaultSharedPreferences(context).edit().putBoolean(split,false).commit();
        try(var providers=new LocalProviders()){
            providers.install(app,inspected.stream().filter(info->info.authority!=null&&Arrays.asList(info.authority.split(";")).contains("com.google.android.gms.microg.settings")).toList());
            List<String> fields=List.of("LICENSING","ASSET_DELIVERY","SPLIT_INSTALL","BILLING","LICENSING_PURCHASE_FREE_APPS");
            String[] columns=new String[fields.size()];for(int i=0;i<columns.length;i++)columns[i]=(String)contract.getField(fields.get(i)).get(null);
            Uri uri=Uri.parse("content://com.google.android.gms.microg.settings/vending");
            try(var cursor=context.getContentResolver().query(uri,columns,null,null,null)){
                check(cursor!=null&&cursor.moveToFirst(),"original settings cursor");
                for(int i=0;i<columns.length;i++)check(cursor.getInt(i)==(i<2||i==3?1:0),"original setting "+fields.get(i));
            }
            IBinder billing=billing(context,Path.of(args[3]));
            check(billingSupport(billing,context.getPackageName())==0,"original billing API discovery is enabled");
            billingCallback(billing,context.getPackageName());
            Class<?> checkin=Class.forName("org.microg.gms.settings.SettingsContract$CheckIn",true,loader);
            String registration=(String)checkin.getField("ENABLED").get(null);
            Uri registrationUri=Uri.parse("content://com.google.android.gms.microg.settings/check-in");
            try(var cursor=context.getContentResolver().query(registrationUri,new String[]{registration},null,null,null)){
                check(cursor.moveToFirst()&&cursor.getInt(0)==1,"original device registration enabled by Google opt-in");
            }
            var registrationChoice=new ContentValues();registrationChoice.put(registration,false);
            context.getContentResolver().update(registrationUri,registrationChoice,null,null);
            var values=new ContentValues();values.put(columns[0],false);values.put(columns[3],false);context.getContentResolver().update(uri,values,null,null);
            var holder=new ContentProviderHolder(inspected.stream().filter(info->info.authority!=null&&info.authority.contains(".microg.settings")).findFirst().orElseThrow());holder.provider=providers.acquire("com.google.android.gms.microg.settings");
            HostGoogleProviders.published(context,List.of(holder));
            try(var cursor=context.getContentResolver().query(registrationUri,new String[]{registration},null,null,null)){
                check(cursor.moveToFirst()&&cursor.getInt(0)==0,"explicit disabled registration preserved");
            }
            try(var cursor=context.getContentResolver().query(uri,new String[]{columns[0]},null,null,null)){check(cursor.moveToFirst()&&cursor.getInt(0)==0,"explicit disabled setting preserved on later publication");}
            check(billingSupport(billing,context.getPackageName())==3,"explicit disabled billing remains an original unavailable response");
            System.out.println("PASS original billing discovery and initialization callback; explicit disabled choice preserved, no purchase requested");
            System.out.println("PASS original Google settings provider: opted-in defaults, explicit choices and entitlement unchanged");
        }finally{HostRemoteServices.shutdown();HostApplication.shutdown();HostWindowManager.shutdown();DynamicDex.hostShutdown();FrameworkResources.shutdown();HostLooper.close(loop);HostContext.hostShutdown();}
        System.exit(0);
    }
}
