package maclauncher.android.fixture;

import android.os.*;
import maclauncher.android.framework.HostBinderRpc;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;

/** Two real RPC sessions exercise forwarded original Binder references. */
public final class BinderRelayProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        RuntimeFixture.initialize(args[0],args[1]);
        var peer=new HostBinderRpc.Peer("fixture.provider","fixture.provider",(int)ProcessHandle.current().pid(),10001);
        Binder original=new Binder(){@Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException{
            check(code==1&&data.readInt()==19,"Forwarded original transaction");
            IBinder callback=data.readStrongBinder();Parcel call=Parcel.obtain(),answer=Parcel.obtain();
            try{call.writeInt(41);check(callback.transact(1,call,answer,0),"Nested result callback");check(answer.readInt()==43,"Nested callback payload");}
            finally{call.recycle();answer.recycle();}
            reply.writeStrongBinder(this);reply.writeInt(23);return true;
        }};
        Binder forwarding=new Binder(){@Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException{
            IBinder target=data.readStrongBinder(),callback=data.readStrongBinder();
            Parcel call=code==1?Parcel.obtain():Parcel.obtain(target),answer=Parcel.obtain();
            try{call.writeInt(19);call.writeStrongBinder(callback);check(target.transact(1,call,answer,0),"Cross-session target dispatch");
                check(answer.readStrongBinder()==target,"Identity on originating session");check(answer.readInt()==23,"Forwarded result");
                reply.writeStrongBinder(target);reply.writeStrongBinder(callback);return true;}
            finally{call.recycle();answer.recycle();}
        }};
        var first=ParcelFileDescriptor.createSocketPair();var second=ParcelFileDescriptor.createSocketPair();
        var serverA=HostBinderRpc.serve(first[0],peer,original,4);var serverB=HostBinderRpc.serve(second[0],peer,forwarding,4);
        var clientA=HostBinderRpc.connect(first[1],peer,4);var clientB=HostBinderRpc.connect(second[1],peer,4);
        for(var descriptor:new ParcelFileDescriptor[]{first[0],first[1],second[0],second[1]})descriptor.close();
        try{
            IBinder remote=clientA.root();check(remote!=original,"Original endpoint must traverse RPC");
            Binder callback=new Binder(){@Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags){check(data.readInt()==41,"Result input");reply.writeInt(43);return true;}};
            for(int i=0;i<4;i++){
                Parcel call=(i&1)==0?Parcel.obtain():Parcel.obtain(clientB.root()),answer=Parcel.obtain();
                try{call.writeStrongBinder(remote);call.writeStrongBinder(callback);check(clientB.root().transact((i&1)+1,call,answer,0),"Cross-session export from plain and typed Parcel.obtain");
                    check(answer.readStrongBinder()==remote,"Round trip retains exact original Binder identity");
                    check(answer.readStrongBinder()==callback,"Round trip retains local callback identity");}
                finally{call.recycle();answer.recycle();}
            }
        }finally{
            clientA.close();clientB.close();serverA.close();serverB.close();
            for(var connection:new HostBinderRpc.Connection[]{clientA,clientB,serverA,serverB})connection.closed().toCompletableFuture().get(10,TimeUnit.SECONDS);
        }
        generatedAidl(peer);
        System.out.println("PASS Binder relay: original identity, nested callbacks, result payloads and session retirement; original generated AIDL and plain/typed Parcel obtains");
    }
    static void generatedAidl(HostBinderRpc.Peer peer)throws Exception{
        IMessenger original=new IMessenger.Stub(){@Override public void send(Message request)throws RemoteException{
            Message reply=Message.obtain();reply.arg1=29;reply.setData(new Bundle(request.getData()));request.replyTo.send(reply);
        }};
        IMessenger forwarding=new IMessenger.Stub(){@Override public void send(Message request)throws RemoteException{
            IMessenger.Stub.asInterface(request.getData().getBinder("target")).send(request);
        }};
        var first=ParcelFileDescriptor.createSocketPair();var second=ParcelFileDescriptor.createSocketPair();
        var serverA=HostBinderRpc.serve(first[0],peer,original.asBinder(),4);var serverB=HostBinderRpc.serve(second[0],peer,forwarding.asBinder(),4);
        var clientA=HostBinderRpc.connect(first[1],peer,4);var clientB=HostBinderRpc.connect(second[1],peer,4);
        for(var descriptor:new ParcelFileDescriptor[]{first[0],first[1],second[0],second[1]})descriptor.close();
        try{
            IBinder target=clientA.root();CountDownLatch finished=new CountDownLatch(1);AtomicReference<Throwable> failure=new AtomicReference<>();
            IMessenger callback=new IMessenger.Stub(){@Override public void send(Message response){
                try{check(response.arg1==29&&response.getData().getBinder("target")==target,"Original generated AIDL retains callback payload and Binder identity");}
                catch(Throwable error){failure.set(error);}finally{finished.countDown();}
            }};
            Message request=Message.obtain();request.getData().putBinder("target",target);request.replyTo=new Messenger(callback.asBinder());
            IMessenger.Stub.asInterface(clientB.root()).send(request);
            check(finished.await(5,TimeUnit.SECONDS),"Original generated AIDL callback completes");
            if(failure.get()!=null)throw new AssertionError(failure.get());
        }finally{
            clientA.close();clientB.close();serverA.close();serverB.close();
            for(var connection:new HostBinderRpc.Connection[]{clientA,clientB,serverA,serverB})connection.closed().toCompletableFuture().get(10,TimeUnit.SECONDS);
        }
    }
}
