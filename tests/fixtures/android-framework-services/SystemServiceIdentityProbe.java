package maclauncher.android.fixture;

import android.os.*;
import android.content.*;
import java.nio.file.*;
import java.util.concurrent.*;
import maclauncher.android.framework.*;

/** An application RPC calls provider code which then calls an Android system service. */
public final class SystemServiceIdentityProbe {
    private static void check(boolean value){if(!value)throw new AssertionError();}
    public static void main(String[] args)throws Exception{
        boolean server=args[0].equals("server");Path data=Files.createDirectories(Path.of(args[3],args[0]));
        RuntimeFixture.initialize(args[2],data.toString());
        int uid=server?20001:20002,peerUid=server?20002:20001;
        HostProcessIdentity.configure(uid,(int)new com.sun.security.auth.module.UnixSystem().getUid());
        int peerPid=Integer.parseInt(args[4]);
        var peer=new HostBinderRpc.Peer(server?"fixture.client":"fixture.provider",server?"fixture.client":"fixture.provider",peerPid,peerUid);
        try(var fd=ParcelFileDescriptor.adoptFd(Integer.parseInt(args[5]))){
            if(server){
                IUserManager target=new IUserManager.Default(){
                    @Override public int getUserSerialNumber(int expected){
                        if(expected!=Binder.getCallingUid())throw new SecurityException("Unexpected caller");
                        return Binder.getCallingUid();
                    }
                    @Override public String getUserName(){return HostBinderRpc.callingPeer()==null?"local":"remote";}
                };
                HostServices.register("fixture.identity",target,"android.os.IUserManager");
                IIntentSender sender=new IIntentSender.Stub(){@Override public void send(int code,Intent intent,String type,IBinder token,IIntentReceiver receiver,String permission,Bundle options){}};
                CountDownLatch finished=new CountDownLatch(1);
                Binder endpoint=new Binder(){@Override protected boolean onTransact(int code,Parcel request,Parcel reply,int flags)throws RemoteException{
                    if(code==2){
                        IIntentSender returned=IIntentSender.Stub.asInterface(request.readStrongBinder());
                        check(returned==sender&&returned.asBinder()==sender.asBinder());
                        check(Binder.getCallingUid()==peerUid&&HostBinderRpc.callingPeer().equals(peer));
                        reply.writeInt(43);finished.countDown();return true;
                    }
                    check(Binder.getCallingUid()==peerUid&&HostBinderRpc.callingPeer().equals(peer));
                    check(target.getUserSerialNumber(peerUid)==peerUid&&target.getUserName().equals("remote"));
                    var client=IUserManager.Stub.asInterface(HostServices.client().getService("fixture.identity"));
                    check(client.getUserSerialNumber(uid)==uid&&client.getUserName().equals("local"));
                    check(((HostServiceClients.Target)client).platformTarget()==target);
                    check(Binder.getCallingUid()==peerUid&&HostBinderRpc.callingPeer().equals(peer));
                    try{client.getUserSerialNumber(peerUid);throw new AssertionError("Caller spoof accepted");}catch(SecurityException expected){}
                    check(Binder.getCallingUid()==peerUid&&HostBinderRpc.callingPeer().equals(peer));
                    check(target.getUserSerialNumber(peerUid)==peerUid&&target.getUserName().equals("remote"));
                    reply.writeInt(42);reply.writeStrongInterface((IIntentSender)HostServiceClients.result(sender,IIntentSender.class));return true;
                }};
                try(var connection=HostBinderRpc.serve(fd,peer,endpoint,2)){check(finished.await(15,TimeUnit.SECONDS));Thread.sleep(30);}
            }else{
                try(var connection=HostBinderRpc.connect(fd,peer,2)){
                    IBinder remote=connection.root();Parcel request=Parcel.obtain(remote),reply=Parcel.obtain();
                    IBinder handle;
                    try{check(remote.transact(1,request,reply,0));check(reply.readInt()==42);handle=reply.readStrongBinder();}finally{request.recycle();reply.recycle();}
                    request=Parcel.obtain(remote);reply=Parcel.obtain();
                    try{request.writeStrongBinder(handle);check(remote.transact(2,request,reply,0));check(reply.readInt()==43);}finally{request.recycle();reply.recycle();}
                }
                System.out.println("PASS system-service caller hop: provider identity, original incoming identity, strict checks and exceptional restoration");
            }
        }
    }
}
