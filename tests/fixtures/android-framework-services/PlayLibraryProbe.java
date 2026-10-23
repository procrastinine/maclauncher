package maclauncher.android;
import android.os.*;
import java.util.concurrent.*;
import maclauncher.android.fixture.RuntimeFixture;

public final class PlayLibraryProbe {
    public static void main(String[] args)throws Exception{
        RuntimeFixture.initialize(args[0],args[1]);
        for(int response:new int[]{0,1,2,3,4,5,257}){
            var result=new CompletableFuture<PlayLibraryOperation.Result>();
            Binder provider=new Binder(){protected boolean onTransact(int transaction,Parcel data,Parcel reply,int flags)throws RemoteException{
                if(transaction!=FIRST_CALL_TRANSACTION||flags!=FLAG_ONEWAY)throw new AssertionError("public LVL transaction");
                data.enforceInterface(PlayLibraryOperation.SERVICE);
                if(data.readLong()!=72634||!data.readString().equals("example.original.package"))throw new AssertionError("caller identity or nonce");
                IBinder listener=data.readStrongBinder();data.enforceNoDataAvail();
                Parcel answer=Parcel.obtain();try{answer.writeInterfaceToken(PlayLibraryOperation.LISTENER);answer.writeInt(response);answer.writeString("synthetic-private-response");answer.writeString("synthetic-private-signature");listener.transact(FIRST_CALL_TRANSACTION,answer,null,FLAG_ONEWAY);}finally{answer.recycle();}return true;
            }};
            PlayLibraryOperation.request(provider,"example.original.package",72634,result);
            var value=result.get(1,TimeUnit.SECONDS);
            if(value.code()!=response||!value.status().equals(response==0||response==2?"licensed":response==1?"not-licensed":"failure"))throw new AssertionError("original response changed");
        }
        var unavailable=new CompletableFuture<PlayLibraryOperation.Result>();
        PlayLibraryOperation.request(new Binder(),"example.original.package",1,unavailable);
        if(!unavailable.get(1,TimeUnit.SECONDS).status().equals("unavailable"))throw new AssertionError("missing protocol");
        maclauncher.android.framework.PreferenceLeaseProbe.run(java.nio.file.Path.of(args[1]));
        System.out.println("PASS original LVL Binder protocol and provider preference recovery");
        System.exit(0);
    }
}
