package maclauncher.android.fixture;

import android.os.*;
import maclauncher.android.framework.HostBinderRpc;
import maclauncher.android.framework.HostProcessIdentity;
import java.nio.file.*;
import java.util.concurrent.*;

public final class BinderRpcJavaProbe {
    static void check(boolean value){if(!value)throw new AssertionError();}
    public static void main(String[] args)throws Exception{
        String role=args[0];Path data=Path.of(args[3],role);Files.createDirectories(data);
        RuntimeFixture.initialize(args[2],data.toString());
        int hostUid=(int)new com.sun.security.auth.module.UnixSystem().getUid();
        int ownUid=role.equals("server")?20001:20002,peerUid=role.equals("server")?20002:20001;
        try{HostProcessIdentity.configure(ownUid,hostUid+1);throw new AssertionError("Untrusted host UID accepted");}catch(SecurityException expected){}
        HostProcessIdentity.configure(ownUid,hostUid);
        check(android.os.Process.myUid()==ownUid&&android.system.Os.getuid()==ownUid&&android.system.Os.geteuid()==ownUid);
        int ownPid=android.os.Process.myPid();
        check(Binder.getCallingPid()==ownPid&&Binder.getCallingUid()==ownUid);
        check(android.system.Os.getpid()==ownPid);
        check(new com.sun.security.auth.module.UnixSystem().getUid()==hostUid);
        Path ownedFile=Files.writeString(data.resolve("identity-file"),"owned");
        check(android.system.Os.stat(ownedFile.toString()).st_uid==ownUid);
        android.system.Os.chown(ownedFile.toString(),ownUid,ownUid);
        try(var file=ParcelFileDescriptor.open(ownedFile.toFile(),ParcelFileDescriptor.MODE_READ_WRITE)){
            android.system.Os.fchown(file.getFileDescriptor(),ownUid,-1);
            check(android.system.Os.fstat(file.getFileDescriptor()).st_uid==ownUid);
        }
        check((int)Files.getAttribute(ownedFile,"unix:uid")==hostUid);
        try{HostProcessIdentity.configure(peerUid,hostUid);throw new AssertionError("Principal replacement accepted");}catch(SecurityException expected){}
        String peerRole=role.equals("server")?"client":"server";
        Path shared=Path.of(args[3]),pidFile=shared.resolve(role+"-pid");
        Files.writeString(pidFile,Integer.toString(ownPid));
        long deadline=System.nanoTime()+5_000_000_000L;
        Path peerPidFile=shared.resolve(peerRole+"-pid");
        while(!Files.exists(peerPidFile)&&System.nanoTime()<deadline)Thread.sleep(5);
        int peerPid=Integer.parseInt(Files.readString(peerPidFile)),descriptor=Integer.parseInt(args[5]);
        check(peerPid!=ownPid);
        var peer=new HostBinderRpc.Peer("fixture."+peerRole,"fixture."+peerRole,peerPid,peerUid);
        try(ParcelFileDescriptor bootstrap=ParcelFileDescriptor.adoptFd(descriptor)){
            if(role.equals("server")){
                CountDownLatch stopped=new CountDownLatch(1);
                Binder endpoint=new Binder(){@Override protected boolean onTransact(int code,Parcel request,Parcel reply,int flags)throws RemoteException{
                    check(Binder.getCallingPid()==peerPid&&Binder.getCallingUid()==peerUid);check(HostBinderRpc.callingPeer().equals(peer));
                    long token=Binder.clearCallingIdentity();check(Binder.getCallingPid()==android.os.Process.myPid()&&Binder.getCallingUid()==ownUid);check(HostBinderRpc.callingPeer()==null);Binder.restoreCallingIdentity(token);check(Binder.getCallingPid()==peerPid&&Binder.getCallingUid()==peerUid);check(HostBinderRpc.callingPeer().equals(peer));
                    if(code==1){IBinder callback=request.readStrongBinder();try(ParcelFileDescriptor input=request.readFileDescriptor();var stream=new ParcelFileDescriptor.AutoCloseInputStream(input)){
                        check(stream.read()==41);
                    }catch(java.io.IOException failure){throw new IllegalStateException(failure);}
                    Parcel nested=Parcel.obtain(callback),response=Parcel.obtain();try{nested.writeInt(17);check(callback.transact(1,nested,response,0));check(response.readInt()==29);}finally{nested.recycle();response.recycle();}
                    reply.writeInt(android.os.Process.myPid());return true;}
                    if(code==2){stopped.countDown();return true;}
                    if(code==3){
                        Bundle original=request.readTypedObject(Bundle.CREATOR),copy=new Bundle(original);
                        check("lazy payload".equals(copy.getString("text"))&&copy.getBundle("nested").getInt("value")==47);
                        IBinder callback=copy.getBinder("callback");Parcel nested=Parcel.obtain(callback),response=Parcel.obtain();
                        try{nested.writeInt(17);check(callback.transact(1,nested,response,0));check(response.readInt()==29);}finally{nested.recycle();response.recycle();}
                        reply.writeTypedObject(copy,0);return true;
                    }
                    if(code==4){
                        request.enforceInterface("fixture.legacy");
                        Bundle copy=new Bundle(request.readTypedObject(Bundle.CREATOR));
                        check(copy.getBundle("nested").getInt("value")==47);
                        try(ParcelFileDescriptor input=request.readFileDescriptor();var stream=new ParcelFileDescriptor.AutoCloseInputStream(input)){
                            check(stream.read()==43);
                        }catch(java.io.IOException failure){throw new IllegalStateException(failure);}
                        IBinder callback=copy.getBinder("callback");
                        // Older generated AIDL uses plain obtain on both sides.
                        // Re-exporting the received RPC Binder also retains its real owner.
                        Parcel call=Parcel.obtain(),result=Parcel.obtain();
                        try{call.writeInterfaceToken("fixture.legacy.callback");call.writeTypedObject(copy,0);check(callback.transact(2,call,result,0));result.readException();}
                        finally{call.recycle();result.recycle();}
                        reply.writeNoException();reply.writeTypedObject(copy,0);return true;
                    }return false;
                }};
                var connection=HostBinderRpc.serve(bootstrap,peer,endpoint,4);
                check(stopped.await(15,TimeUnit.SECONDS));connection.close();connection.closed().toCompletableFuture().get(10,TimeUnit.SECONDS);
            }else{
                var connection=HostBinderRpc.connect(bootstrap,peer,4);IBinder remote=connection.root();
                int[] transactionError={-1,-1};
                Binder.setTransactionCallback((pid,code,flags,error)->{transactionError[0]=pid;transactionError[1]=code;});
                Parcel unknown=Parcel.obtain(remote),unknownReply=Parcel.obtain();
                try{check(!remote.transact(99,unknown,unknownReply,0));check(transactionError[0]==ownPid&&transactionError[1]==99);}
                finally{unknown.recycle();unknownReply.recycle();Binder.setTransactionCallback(null);}
                Binder callback=new Binder(){@Override protected boolean onTransact(int code,Parcel request,Parcel reply,int flags){check(Binder.getCallingPid()==peerPid&&Binder.getCallingUid()==peerUid);check(HostBinderRpc.callingPeer().equals(peer));if(code==2){request.enforceInterface("fixture.legacy.callback");Bundle value=request.readTypedObject(Bundle.CREATOR);check(value.getBinder("callback")==this&&value.getBundle("nested").getInt("value")==47);reply.writeNoException();return true;}check(request.readInt()==17);reply.writeInt(29);return true;}};
                ParcelFileDescriptor[] pipe=ParcelFileDescriptor.createPipe();try(var out=new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])){out.write(41);}
                Parcel request=Parcel.obtain(remote),reply=Parcel.obtain();try{request.writeStrongBinder(callback);request.writeFileDescriptor(pipe[0].getFileDescriptor());pipe[0].close();check(remote.transact(1,request,reply,0));check(reply.readInt()==peerPid);}finally{request.recycle();reply.recycle();}
                Bundle input=new Bundle(),nested=new Bundle();nested.putInt("value",47);input.putString("text","lazy payload");input.putBundle("nested",nested);input.putBinder("callback",callback);
                Bundle output;request=Parcel.obtain(remote);reply=Parcel.obtain();try{request.writeTypedObject(input,0);check(remote.transact(3,request,reply,0));output=new Bundle(reply.readTypedObject(Bundle.CREATOR));}finally{request.recycle();reply.recycle();}
                check(output.getString("text").equals("lazy payload")&&output.getBundle("nested").getInt("value")==47&&output.getBinder("callback")==callback);
                pipe=ParcelFileDescriptor.createPipe();try(var out=new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])){out.write(43);}
                request=Parcel.obtain();reply=Parcel.obtain();
                try{request.writeInterfaceToken("fixture.legacy");request.writeTypedObject(input,0);request.writeFileDescriptor(pipe[0].getFileDescriptor());pipe[0].close();check(remote.transact(4,request,reply,0));reply.readException();output=new Bundle(reply.readTypedObject(Bundle.CREATOR));}
                finally{request.recycle();reply.recycle();}
                check(output.getBinder("callback")==callback&&output.getBundle("nested").getInt("value")==47);
                request=Parcel.obtain(remote);reply=Parcel.obtain();try{check(remote.transact(2,request,null,IBinder.FLAG_ONEWAY));}finally{request.recycle();reply.recycle();}
                connection.close();connection.closed().toCompletableFuture().get(10,TimeUnit.SECONDS);
                System.out.println("PASS original Java Binder RPC: isolated processes, nested callbacks, caller identity, FD transfer and asynchronous shutdown; lazy nested Bundle ownership survives parcel recycling");
            }
        }
        check(Binder.getCallingPid()==ownPid&&Binder.getCallingUid()==ownUid);
    }
}
