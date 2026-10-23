package maclauncher.android;

import android.app.Application;
import android.content.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.fixture.*;
import maclauncher.android.framework.*;

/** Original Context/LoadedApk service binding to a separately installed real APK. */
public final class InstalledServiceClient {
    public static void main(String[] args)throws Exception{
        LaunchConfig config=LaunchConfig.read(Path.of(args[0]));Path runtime=config.directory("runtimeRoot"),data=config.directory("filesRoot").getParent();
        Looper loop=RuntimeFixture.initialize(runtime.toString(),data.toString());
        try(ProcessAuthority authority=ProcessAuthority.read(config)){
            HostProcessIdentity.configure(authority.self.uid(),authority.self.gid(),authority.self.groups(),authority.self.hostUid(),authority.self.securityContext());
            HostGoogleProviders.configure(config.googleProviderCompatibility());
            HostContext.hostPackage(config.text("packageName"),"1",1);HostContext.hostApplicationInfo(false,config.file("sourceApk").toString(),data.toString(),config.directory("nativeRoot").toString(),28);HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
            FrameworkResources.configure(runtime.resolve("android-framework.jar"),config.sourceApks());HostPackages.inspectSources(config.sourceApks());HostPackages.inspectInstalled(config.optional("installedPackagesJson"));
            HostStorageService.install();HostApplication.prepare(InstalledServiceClient.class.getClassLoader());Context context=HostApplication.applicationContext();Application app=new Application();HostApplication.attach(app,context);HostApplication.create(app);
            authority.monitor(context,()->HostLooper.close(loop));
            if(args[1].equals("--accounts")){
                var field=HostRemoteServices.class.getDeclaredField("processes");field.setAccessible(true);
                var processes=(HostProcessServices)field.get(null);
                accounts(context,loop,processes.find("com.google.android.gms","com.google.android.gms:persistent").service(Context.ACCOUNT_SERVICE));return;
            }
            ComponentName name=new ComponentName(args[1],args[2]);Intent intent=new Intent(args[3]).setComponent(name).putExtra("client-library-version","1");
            IBinder[] connected={null};boolean[] nullBinding={false};ServiceConnection callback=new ServiceConnection(){
                public void onServiceConnected(ComponentName actual,IBinder service){if(!actual.equals(name))throw new AssertionError("Wrong installed component");connected[0]=service;}
                public void onServiceDisconnected(ComponentName actual){}
                public void onNullBinding(ComponentName actual){nullBinding[0]=true;}
            };
            if(!context.bindService(intent,callback,Context.BIND_AUTO_CREATE))throw new AssertionError("Installed service binding rejected");
            long deadline=System.nanoTime()+15_000_000_000L;
            while(connected[0]==null&&!nullBinding[0]&&System.nanoTime()<deadline){HostLooper.drain(loop);Thread.sleep(5);}
            if(connected[0]==null)throw new AssertionError(nullBinding[0]?"Installed service returned a null binding":"Installed service did not connect");
            System.out.println("PASS actual installed service "+name.flattenToShortString()+" binder="+connected[0].getInterfaceDescriptor()+" clientUid="+android.os.Process.myUid());
            if(args.length>4&&args[4].equals("--age-signals"))ageSignals(context,loop,connected[0]);
            context.unbindService(callback);HostLooper.drain(loop);
        }finally{
            HostRemoteServices.shutdown();HostApplication.shutdown();HostWindowManager.shutdown();FrameworkResources.shutdown();HostLooper.close(loop);HostContext.hostShutdown();
        }
    }
    /** Wire contract from Companion's supplied AIDL; no client or service behavior is replaced. */
    private static void ageSignals(Context context,Looper loop,IBinder service)throws Exception{
        String descriptor="com.google.android.play.agesignals.protocol.IAgeSignalsService";
        String callbackDescriptor="com.google.android.play.agesignals.protocol.IAgeSignalsServiceCallback";
        java.util.concurrent.atomic.AtomicReference<Bundle> response=new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.atomic.AtomicReference<Bundle> error=new java.util.concurrent.atomic.AtomicReference<>();
        Binder callback=new Binder(){
            @Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException{
                if(code==INTERFACE_TRANSACTION){if(reply!=null)reply.writeString(callbackDescriptor);return true;}
                data.enforceInterface(callbackDescriptor);
                if(code==FIRST_CALL_TRANSACTION){response.set(data.readTypedObject(Bundle.CREATOR));return true;}
                if(code==FIRST_CALL_TRANSACTION+2){error.set(data.readTypedObject(Bundle.CREATOR));return true;}
                return super.onTransact(code,data,reply,flags);
            }
        };
        Parcel request=Parcel.obtain(service);try{
            request.writeInterfaceToken(descriptor);request.writeString(context.getPackageName());
            Bundle version=new Bundle();version.putInt("playcore.version.code",4);request.writeTypedObject(version,0);request.writeStrongBinder(callback);
            if(!service.transact(IBinder.FIRST_CALL_TRANSACTION,request,null,IBinder.FLAG_ONEWAY))throw new AssertionError("Installed age service did not accept its original protocol");
        }finally{request.recycle();}
        long deadline=System.nanoTime()+15_000_000_000L;
        while(response.get()==null&&error.get()==null&&System.nanoTime()<deadline){HostLooper.drain(loop);Thread.sleep(5);}
        if(error.get()!=null)throw new AssertionError("Installed age service rejected its actual caller: "+error.get().getInt("error.code"));
        if(response.get()==null||response.get().getInt("age.signals.status",-1)!=2)throw new AssertionError("Installed age service did not report its actual NOT_SHARED status");
        System.out.println("PASS original Companion age service, authenticated caller and NOT_SHARED response; no age was invented");
    }
    private static void accounts(Context context,Looper loop,IBinder directory)throws Exception{
        var endpoint=android.accounts.IAccountManager.Stub.asInterface(directory);
        if(endpoint==null)throw new AssertionError("Installed account owner is missing");
        var manager=new android.accounts.AccountManager(context,endpoint);
        if(Arrays.stream(manager.getAuthenticatorTypes()).noneMatch(type->type.type.equals("com.google")&&type.packageName.equals("com.google.android.gms")))throw new AssertionError("Actual installed Google authenticator was not discovered");
        if(manager.getAccounts().length!=0)throw new AssertionError("An account was unexpectedly present in the isolated account owner");
        java.util.concurrent.atomic.AtomicReference<Bundle> result=new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.atomic.AtomicReference<Throwable> failure=new java.util.concurrent.atomic.AtomicReference<>();
        manager.addAccount("com.google",null,null,new Bundle(),null,future->{try{result.set(future.getResult());}catch(Throwable error){failure.set(error);}},new Handler(loop));
        long deadline=System.nanoTime()+15_000_000_000L;
        while(result.get()==null&&failure.get()==null&&System.nanoTime()<deadline){HostLooper.drain(loop);Thread.sleep(5);}
        if(failure.get()!=null)throw new AssertionError("Original authenticator request failed",failure.get());
        Intent intent=result.get()==null?null:result.get().getParcelable(android.accounts.AccountManager.KEY_INTENT,Intent.class);
        if(intent==null||intent.getComponent()==null||!intent.getComponent().getPackageName().equals("com.google.android.gms"))throw new AssertionError("Installed authenticator did not return its actual sign-in Activity");
        if(!intent.hasExtra(android.accounts.AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE))throw new AssertionError("Authenticator response Binder was lost");
        System.out.println("PASS original AccountManager, actual installed authenticator and sign-in Intent Binder; no sign-in Activity was launched");
    }
}
