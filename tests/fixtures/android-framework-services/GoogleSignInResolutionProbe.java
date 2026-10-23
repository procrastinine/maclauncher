package maclauncher.android.framework;

import android.app.PendingIntent;
import android.content.*;
import android.os.*;
import java.lang.reflect.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.DynamicDex;
import maclauncher.android.fixture.RuntimeFixture;

/** Original installed broker proxies and parcelables over the full framework. */
public final class GoogleSignInResolutionProbe {
    static final String BROKER="com.google.android.gms.common.internal.IGmsServiceBroker",CALLBACK="com.google.android.gms.common.internal.IGmsCallbacks";
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static ClassLoader loader;static Object originalInfo,originalRequest;static Bundle originalBundle;
    static IBinder service,receivedService,receivedCallbacks;static int callbackCode,status,brokerCalls;static Bundle params;static Object info;
    static boolean adaptedService;
    static int callbackShape=3,requestedStatus=4;static int deaths,undeaths;
    static Object api(String name,IBinder binder)throws Exception{return Class.forName(name+"$Stub",true,loader).getMethod("asInterface",IBinder.class).invoke(null,binder);}
    static Object parcelable(Parcel parcel,String name)throws Exception{return parcel.readTypedObject((Parcelable.Creator<?>)Class.forName(name,true,loader).getField("CREATOR").get(null));}
    static void invoke(Object owner,String method,Object... args)throws Exception{
        Method selected=Arrays.stream(owner.getClass().getMethods()).filter(value->value.getName().equals(method)&&value.getParameterCount()==args.length).findFirst().orElseThrow();
        selected.setAccessible(true);try{selected.invoke(owner,args);}catch(InvocationTargetException failure){if(failure.getCause()instanceof Exception error)throw error;throw failure;}
    }
    static void exchange(IBinder broker)throws Exception{
        IBinder callback=new Binder(){
            {attachInterface(null,CALLBACK);}
            @Override public void linkToDeath(DeathRecipient recipient,int flags){deaths++;}
            @Override public boolean unlinkToDeath(DeathRecipient recipient,int flags){undeaths++;return true;}
            @Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException{
                if(code<1||code>3)return super.onTransact(code,data,reply,flags);
                data.enforceInterface(CALLBACK);callbackCode=code;status=data.readInt();
                IBinder actual=code==2?null:data.readStrongBinder();receivedService=actual;check(code==2||(adaptedService?actual!=null:actual==service),"original service Binder identity or exact policy adapter");
                try{info=code==3?parcelable(data,"com.google.android.gms.common.internal.ConnectionInfo"):null;params=code==3?(Bundle)info.getClass().getField("params").get(info):data.readTypedObject(Bundle.CREATOR);}
                catch(Exception failure){throw new AssertionError(failure);}
                data.enforceNoDataAvail();reply.writeNoException();return true;
            }
        };
        invoke(api(BROKER,broker),"getService",api(CALLBACK,callback),originalRequest);
        check(callbackCode==callbackShape&&status==requestedStatus,"original callback shape and status");
        check(params.getInt("marker")==73&&params.getBinder("owner")==originalBundle.getBinder("owner"),"non-resolution metadata and Binder owner");
        if(info!=null)check(info.getClass().getField("unknown3").getInt(info)==91,"original ConnectionInfo fields");
    }
    static final String GAMES="com.google.android.gms.games.internal.connect.IGamesConnectService",GAMES_CALLBACK="com.google.android.gms.games.internal.connect.IGamesConnectCallbacks";
    static Object originalStatus,receivedStatus,originalResponse,receivedResponse;static int gamesCalls,gamesStatus=4,gamesCallbacks;
    static IBinder gamesCallback;
    static void gamesExchange(IBinder games)throws Exception{
        IBinder callback=new Binder(){
            {attachInterface(null,GAMES_CALLBACK);}
            @Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException{
                if(code==77){data.enforceInterface(GAMES_CALLBACK);check(data.readInt()==834,"unknown Games callback forwarded");reply.writeNoException();reply.writeInt(835);return true;}
                if(code!=2)return super.onTransact(code,data,reply,flags);data.enforceInterface(GAMES_CALLBACK);gamesCallbacks++;
                try{receivedStatus=parcelable(data,"com.google.android.gms.common.api.Status");receivedResponse=parcelable(data,"com.google.android.gms.games.internal.connect.GamesSignInResponse");}
                catch(Exception failure){throw new AssertionError(failure);}data.enforceNoDataAvail();reply.writeNoException();return true;
            }
        };
        Object request=Class.forName("com.google.android.gms.games.internal.connect.GamesSignInRequest",true,loader).getConstructor().newInstance();
        request.getClass().getField("signInType").setInt(request,1);
        invoke(api(GAMES,games),"signIn",api(GAMES_CALLBACK,callback),request);
        check((Integer)receivedStatus.getClass().getMethod("getStatusCode").invoke(receivedStatus)==gamesStatus,"Games Connect original status");
        check("owned status".equals(receivedStatus.getClass().getMethod("getStatusMessage").invoke(receivedStatus)),"Games Connect status message");
        Field version=receivedStatus.getClass().getDeclaredField("versionCode");version.setAccessible(true);check(version.getInt(receivedStatus)==17,"Games Connect original Status version");
        check("background-token".equals(receivedResponse.getClass().getField("gameRunToken").get(receivedResponse)),"Games Connect response retained");
    }
    static void gamesConnect(Context context,IBinder originalBroker,PendingIntent resolution)throws Exception{
        Class<?> statusType=Class.forName("com.google.android.gms.common.api.Status",true,loader);
        originalResponse=Class.forName("com.google.android.gms.games.internal.connect.GamesSignInResponse",true,loader).getConstructor().newInstance();
        originalResponse.getClass().getField("gameRunToken").set(originalResponse,"background-token");
        IBinder originalGames=new Binder(){
            {attachInterface(null,GAMES);}
            @Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException{
                if(code==77){data.enforceInterface(GAMES);check(data.readInt()==834,"unknown Games transaction forwarded");data.enforceNoDataAvail();reply.writeNoException();reply.writeInt(835);return true;}
                if(code!=2)return super.onTransact(code,data,reply,flags);gamesCalls++;data.enforceInterface(GAMES);gamesCallback=data.readStrongBinder();
                try{Object request=parcelable(data,"com.google.android.gms.games.internal.connect.GamesSignInRequest");check(request.getClass().getField("signInType").getInt(request)==1,"original automatic sign-in request retained");data.enforceNoDataAvail();invoke(api(GAMES_CALLBACK,gamesCallback),"onSignIn",originalStatus,originalResponse);}
                catch(Exception failure){throw new AssertionError(failure);}reply.writeNoException();return true;
            }
        };
        service=originalGames;requestedStatus=0;callbackShape=3;
        originalStatus=statusType.getConstructor(int.class,String.class,PendingIntent.class).newInstance(4,"owned status",resolution);
        Field version=statusType.getDeclaredField("versionCode");version.setAccessible(true);version.setInt(originalStatus,17);
        adaptedService=false;exchange(originalBroker);gamesExchange(receivedService);
        check(statusType.getMethod("getResolution").invoke(receivedStatus)!=null,"unadapted automatic Games sign-in exposes UI");
        HostGoogleProviders.accountInteraction(false);adaptedService=true;IBinder restricted=null,restrictedCallback=null;
        for(int shape:new int[]{1,3}){callbackShape=shape;exchange(HostGoogleProviders.serviceBinder(context,originalBroker));restricted=receivedService;gamesExchange(restricted);restrictedCallback=gamesCallback;check(statusType.getMethod("getResolution").invoke(receivedStatus)==null,"noninteractive Games sign-in has no UI for every service callback shape");check(restricted!=originalGames,"only exact Games service receives a policy adapter");}
        check(statusType.getMethod("getResolution").invoke(originalStatus)==resolution,"provider original Status remains unchanged");
        for(int success:new int[]{0,7}){gamesStatus=success;originalStatus=statusType.getConstructor(int.class,String.class,PendingIntent.class).newInstance(success,"owned status",resolution);version.setInt(originalStatus,17);gamesExchange(restricted);PendingIntent actual=(PendingIntent)statusType.getMethod("getResolution").invoke(receivedStatus);check(actual.getTarget().asBinder()==resolution.getTarget().asBinder(),"other Games statuses retain original resolution Binder");}
        gamesStatus=4;originalStatus=statusType.getConstructor(int.class,String.class,PendingIntent.class).newInstance(4,"owned status",null);version.setInt(originalStatus,17);gamesExchange(restricted);check(statusType.getMethod("getResolution").invoke(receivedStatus)==null,"already resolution-free status4 retained");
        gamesStatus=4;originalStatus=statusType.getConstructor(int.class,String.class,PendingIntent.class).newInstance(4,"owned status",resolution);version.setInt(originalStatus,17);
        HostGoogleProviders.accountInteraction(true);adaptedService=false;exchange(HostGoogleProviders.serviceBinder(context,originalBroker));gamesExchange(receivedService);check(statusType.getMethod("getResolution").invoke(receivedStatus)!=null,"explicit account role retains original Games resolution");
        Parcel request=Parcel.obtain(),reply=Parcel.obtain();try{request.writeInterfaceToken(GAMES);request.writeInt(834);restricted.transact(77,request,reply,0);reply.readException();check(reply.readInt()==835,"unknown Games method retained");}finally{request.recycle();reply.recycle();}
        int calls=gamesCalls;request=Parcel.obtain();reply=Parcel.obtain();try{request.writeInterfaceToken("foreign.interface");request.writeStrongBinder(new Binder());try{restricted.transact(2,request,reply,0);reply.readException();throw new AssertionError("foreign Games descriptor accepted");}catch(SecurityException expected){}check(gamesCalls==calls,"foreign Games request never reaches provider");}finally{request.recycle();reply.recycle();}
        request=Parcel.obtain();reply=Parcel.obtain();try{request.writeInterfaceToken(GAMES_CALLBACK);request.writeInt(834);restrictedCallback.transact(77,request,reply,0);reply.readException();check(reply.readInt()==835,"unknown Games callback method retained");}finally{request.recycle();reply.recycle();}
        int callbacks=gamesCallbacks;request=Parcel.obtain();reply=Parcel.obtain();try{request.writeInterfaceToken("foreign.interface");try{restrictedCallback.transact(2,request,reply,0);reply.readException();throw new AssertionError("foreign Games callback descriptor accepted");}catch(SecurityException expected){}check(gamesCallbacks==callbacks,"foreign Games callback never reaches caller");}finally{request.recycle();reply.recycle();}
        System.out.println("PASS original Games Connect startup callback retains status4 without UI and preserves other statuses, response, explicit account role and transaction authority");
    }
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]).toRealPath(),prepared=Path.of(args[1]).toRealPath(),data=Files.createDirectories(Path.of(args[2])).toRealPath();
        var loop=RuntimeFixture.initialize(runtime.toString(),data.toString());
        service=new Binder();
        Path apk=prepared.resolve(Files.isRegularFile(prepared.resolve("base.apk"))?"base.apk":"source.apk");
        HostGoogleProviders.configure(true);HostContext.hostPackage("com.google.android.gms","fixture",1);
        HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));HostPackages.inspectSources(List.of(apk));
        loader=HostDexFiles.application(prepared.resolve("converted.jar"),List.of(apk),prepared.resolve("input/lib/arm64-v8a"),GoogleSignInResolutionProbe.class.getClassLoader());
        HostContext.hostClassLoader(loader);DynamicDex.configure(runtime,Files.createDirectories(data.resolve("cache")),prepared.resolve("converted.jar"),loader);
        Context context=new ContextWrapper(null){@Override public String getPackageName(){return "com.google.android.gms";}@Override public ClassLoader getClassLoader(){return loader;}};
        Class<?> request=Class.forName("com.google.android.gms.common.internal.GetServiceRequest",true,loader);
        originalRequest=request.getConstructor(int.class).newInstance(1);request.getField("packageName").set(originalRequest,"owned.caller");
        originalInfo=Class.forName("com.google.android.gms.common.internal.ConnectionInfo",true,loader).getConstructor().newInstance();
        PendingIntent resolution=new PendingIntent(new IIntentSender.Stub(){@Override public void send(int code,Intent intent,String type,IBinder token,IIntentReceiver finished,String permission,Bundle options){throw new AssertionError("Interactive resolution must not be sent");}});
        originalBundle=new Bundle();originalBundle.putParcelable("pendingIntent",resolution);originalBundle.putInt("marker",73);originalBundle.putBinder("owner",service);
        originalInfo.getClass().getField("params").set(originalInfo,originalBundle);originalInfo.getClass().getField("unknown3").setInt(originalInfo,91);
        IBinder originalBroker=new Binder(){
            {attachInterface(null,BROKER);}
            @Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException{
                if(code!=46)return super.onTransact(code,data,reply,flags);brokerCalls++;data.enforceInterface(BROKER);receivedCallbacks=data.readStrongBinder();
                try{
                    Object actual=parcelable(data,"com.google.android.gms.common.internal.GetServiceRequest");check("owned.caller".equals(actual.getClass().getField("packageName").get(actual)),"original request metadata");data.enforceNoDataAvail();
                    Object callback=api(CALLBACK,receivedCallbacks);
                    if(callbackShape==1)invoke(callback,"onPostInitComplete",requestedStatus,service,originalBundle);
                    else if(callbackShape==2)invoke(callback,"onAccountValidationComplete",requestedStatus,originalBundle);
                    else invoke(callback,"onPostInitCompleteWithConnectionInfo",requestedStatus,service,originalInfo);
                }catch(Exception failure){throw new AssertionError(failure);}
                reply.writeNoException();return true;
            }
        };
        HostGoogleProviders.accountInteraction(false);exchange(originalBroker);check(params.containsKey("pendingIntent"),"unadapted original status4 retains the interactive capability");
        System.out.println("PASS original unadapted microG sign-in-required response exposes its resolution capability");
        IBinder restricted=HostGoogleProviders.serviceBinder(context,originalBroker);check(restricted!=originalBroker,"verified noninteractive broker is adapted");
        for(int shape=1;shape<=3;shape++){callbackShape=shape;requestedStatus=4;exchange(restricted);check(!params.containsKey("pendingIntent"),"noninteractive status4 has no resolution");check(originalBundle.getParcelable("pendingIntent",PendingIntent.class)==resolution,"provider's original resolution remains owned and unchanged");}
        var death=new IBinder.DeathRecipient(){public void binderDied(){}};receivedCallbacks.linkToDeath(death,0);check(receivedCallbacks.unlinkToDeath(death,0)&&deaths==1&&undeaths==1,"callback death lifecycle delegates to original owner");
        System.out.println("PASS original microG broker callback shapes preserve SIGN_IN_REQUIRED without interactive resolution");
        for(int shape=1;shape<=3;shape++){callbackShape=shape;requestedStatus=0;exchange(restricted);check(params.getParcelable("pendingIntent",PendingIntent.class).getTarget().asBinder()==resolution.getTarget().asBinder(),"successful/background response keeps original resolution Binder");}
        System.out.println("PASS successful Google service responses retain original callback metadata and Binder owners");
        HostGoogleProviders.accountInteraction(true);check(HostGoogleProviders.serviceBinder(context,originalBroker)==originalBroker,"explicit account role retains original broker");requestedStatus=4;callbackShape=3;exchange(originalBroker);check(params.containsKey("pendingIntent"),"explicit account role retains resolution");
        System.out.println("PASS explicit interactive account owner retains original sign-in resolution");
        HostGoogleProviders.accountInteraction(false);int calls=brokerCalls;Parcel invalid=Parcel.obtain(),reply=Parcel.obtain();try{invalid.writeInterfaceToken("foreign.interface");invalid.writeStrongBinder(new Binder());try{restricted.transact(46,invalid,reply,0);reply.readException();throw new AssertionError("foreign descriptor accepted");}catch(SecurityException expected){}check(brokerCalls==calls,"foreign descriptor never reaches provider");}finally{invalid.recycle();reply.recycle();}
        Context unrelated=new ContextWrapper(null){@Override public String getPackageName(){return "owned.provider";}};check(HostGoogleProviders.serviceBinder(unrelated,originalBroker)==originalBroker,"unrelated providers retain original binding");
        System.out.println("PASS descriptor authority and unrelated provider behavior remain intact");
        gamesConnect(context,originalBroker,resolution);
        DynamicDex.hostShutdown();FrameworkResources.shutdown();HostLooper.close(loop);System.exit(0);
    }
}
