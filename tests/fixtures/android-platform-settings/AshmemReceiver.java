import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Parcel;
import android.os.ParcelFileDescriptor;
import android.system.Os;
import android.util.MemoryIntArray;
public final class AshmemReceiver {
 private static native void inspect(int fd,java.io.FileDescriptor socket);
 public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
 private static void run(String[] args)throws Exception{
  System.load("/system/lib64/ashmem-receiver.so");
  try(LocalSocket socket=new LocalSocket()){
   socket.connect(new LocalSocketAddress(args[0],LocalSocketAddress.Namespace.FILESYSTEM));
   if(socket.getInputStream().read()!=1)throw new AssertionError("Descriptor marker missing");
   var received=socket.getAncillaryFileDescriptors();if(received==null||received.length!=1)throw new AssertionError("Descriptor transfer failed");
   try(var fd=ParcelFileDescriptor.dup(received[0])){
    inspect(fd.getFd(),socket.getFileDescriptor());
    Parcel parcel=Parcel.obtain();
    try{
     parcel.writeParcelable(fd,0);parcel.setDataPosition(0);
     try(MemoryIntArray array=MemoryIntArray.CREATOR.createFromParcel(parcel)){
      if(array.isWritable()||array.get(0)!=7||array.size()!=4096)throw new AssertionError("Original MemoryIntArray contents differ");
      boolean denied=false;try{array.set(0,9);}catch(UnsupportedOperationException expected){denied=true;}
      if(!denied)throw new AssertionError("Original read-only API accepted a write");
      socket.getOutputStream().write(2);
      if(socket.getInputStream().read()!=3||array.get(0)!=11)throw new AssertionError("Shared atomic generation did not change after owner close");
      System.out.println("PASS original ART MemoryIntArray CREATOR, shared atomic generation, read-only descriptor and owner-close lifetime");
     }
    }finally{parcel.recycle();}
   }finally{Os.close(received[0]);}
   socket.getOutputStream().write(4);
  }
 }
}
