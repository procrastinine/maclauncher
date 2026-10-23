package maclauncher.android;

import android.app.*;
import android.content.Context;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;

/** Real AIDL proxy/stub dispatch around the existing platform service endpoints. */
public final class ServiceDispatchProbe {
    private static void check(boolean value){if(!value)throw new AssertionError();}
    private static IBinder proxy(IBinder endpoint){return new Binder(){@Override public IInterface queryLocalInterface(String descriptor){return null;}@Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException{return endpoint.transact(code,data,reply,flags);}};}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]).toRealPath(),data=Files.createDirectories(Path.of(args[1])).toRealPath();
        Looper loop=RuntimeFixture.initialize(runtime.toString(),data.toString());System.load(System.getProperty("klepton.graphics"));HostStorageService.install();
        Path apk=data.resolve("fixture.apk");SyntheticResources.apk(apk,"","Service",null);FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
        HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostDisplay.hostPublish(1,320,240,60);HostApplication.prepare(ServiceDispatchProbe.class.getClassLoader());Context context=HostApplication.applicationContext();
        Application application=new Application();HostApplication.attach(application,context);HostApplication.create(application);
        try(HostServiceDirectory directory=new HostServiceDirectory(context)){
            String guestDescriptor="guest.only.CustomService";
            class GuestBinder extends Binder{
                @Override protected boolean onTransact(int code,Parcel request,Parcel reply,int flags)throws RemoteException{
                    if(code!=IBinder.FIRST_CALL_TRANSACTION)return super.onTransact(code,request,reply,flags);
                    request.enforceInterface(guestDescriptor);reply.writeInt(request.readInt()+17);return true;
                }
            }
            IBinder guest=new GuestBinder(){};IInterface guestInterface=()->guest;
            check(HostServiceEndpoints.export(guestInterface,guestDescriptor,context)==guest);
            Parcel request=Parcel.obtain(),reply=Parcel.obtain();
            try{request.writeInterfaceToken(guestDescriptor);request.writeInt(25);check(guest.transact(IBinder.FIRST_CALL_TRANSACTION,request,reply,0));check(reply.readInt()==42);}
            finally{request.recycle();reply.recycle();}
            IUserManager target=new IUserManager.Default(){@Override public String getUserName(){return "actual-service";}@Override public int getUserSerialNumber(int user){return user+83;}};
            HostServices.register("fixture.user",target,"android.os.IUserManager");
            IServiceManager manager=IServiceManager.Stub.asInterface(proxy(directory.root()));
            IBinder binder=manager.getService("fixture.user");check(binder!=null);
            IUserManager client=IUserManager.Stub.asInterface(proxy(binder));check(client.getUserName().equals("actual-service"));check(client.getUserSerialNumber(19)==102);
            check(manager.getService2("fixture.user").getServiceWithMetadata().service!=null);check(Arrays.asList(manager.listServices(IServiceManager.DUMP_FLAG_PRIORITY_ALL)).contains("fixture.user"));
            int[] calls={0};IServiceCallback callback=new IServiceCallback.Stub(){@Override public void onRegistration(String name,IBinder service)throws RemoteException{check(IUserManager.Stub.asInterface(proxy(service)).getUserName().equals("actual-service"));calls[0]++;}};
            manager.registerForNotifications("fixture.next",callback);HostServices.register("fixture.next",target,"android.os.IUserManager");check(calls[0]==1);
            manager.unregisterForNotifications("fixture.next",callback);manager.registerForNotifications("fixture.closed",callback);directory.close();HostServices.register("fixture.closed",target,"android.os.IUserManager");check(calls[0]==1);
            System.out.println("PASS original AIDL service dispatch, metadata, registration callbacks and callback retirement");
        }finally{HostApplication.shutdown();HostWindowManager.shutdown();HostDisplay.hostShutdown();HostDisplay.hostRemove();FrameworkResources.shutdown();HostLooper.close(loop);HostContext.hostShutdown();}
    }
}
