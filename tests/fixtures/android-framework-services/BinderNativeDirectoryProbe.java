package maclauncher.android.fixture;

import android.os.*;
import maclauncher.android.framework.HostBinderRpc;
import maclauncher.android.framework.HostServices;
import maclauncher.android.framework.HostProcessIdentity;
import java.util.concurrent.TimeUnit;

public final class BinderNativeDirectoryProbe {
    private static native void probe(IBinder directory,int ownPid,int ownUid,int physicalPid);
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        RuntimeFixture.initialize(args[0],args[1]);System.load(args[2]);
        HostProcessIdentity.configure(20001,(int)new com.sun.security.auth.module.UnixSystem().getUid());
        HostServices.register("permission",new IPermissionController.Stub(){
            @Override public boolean checkPermission(String permission,int pid,int uid){return false;}
            @Override public int noteOp(String op,int uid,String packageName){return 0;}
            @Override public String[] getPackagesForUid(int uid){return new String[0];}
            @Override public boolean isRuntimePermission(String permission){return false;}
            @Override public int getPackageUid(String packageName,int flags){return -1;}
        },"android.os.IPermissionController");
        var peer=new HostBinderRpc.Peer("fixture.native","fixture.native",android.os.Process.myPid(),android.os.Process.myUid());
        Binder target=new Binder(){@Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException{
            check(code==1&&data.readInt()==19,"Native request payload");
            IBinder callback=data.readStrongBinder();
            try(var input=new ParcelFileDescriptor.AutoCloseInputStream(data.readFileDescriptor())){
                check(new String(input.readNBytes(10),java.nio.charset.StandardCharsets.US_ASCII).equals("native-rpc"),"Transferred descriptor retains bytes");
            }catch(java.io.IOException failure){throw new IllegalStateException(failure);}
            long trailing=data.readLong();check(trailing==0x1122334455667788L,"Trailing native payload");
            Parcel request=Parcel.obtain(),response=Parcel.obtain();
            try{request.writeInt(41);check(callback.transact(1,request,response,0),"Original Java callback to native");check(response.readInt()==43,"Native callback payload");}
            finally{request.recycle();response.recycle();}
            reply.writeInt(23);reply.writeStrongBinder(this);reply.writeLong(trailing);return true;
        }};
        var sockets=ParcelFileDescriptor.createSocketPair();
        var server=HostBinderRpc.serve(sockets[0],peer,target,4);
        var client=HostBinderRpc.connect(sockets[1],peer,4);
        sockets[0].close();sockets[1].close();
        try{
            HostServices.manager().addService("fixture.native.transport",client.root(),false,0);
            probe(HostServices.manager().asBinder(),android.os.Process.myPid(),android.os.Process.myUid(),HostProcessIdentity.physicalPid());
        }finally{
            client.close();server.close();
            client.closed().toCompletableFuture().get(10,TimeUnit.SECONDS);
            server.closed().toCompletableFuture().get(10,TimeUnit.SECONDS);
        }
        System.out.println("PASS native Binder directory: original AIDL, cross-session identity, nested callback, file descriptor and retirement");
        System.out.println("PASS original Binder logical process identity, debug PID and permission self shortcut");
    }
}
