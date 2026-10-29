package maclauncher.android;

import android.os.*;
import android.content.Intent;
import java.nio.*;
import java.nio.file.*;
import java.util.*;

public final class RawParcelProbe {
    private static int checks;
    private static void check(boolean value,String label){checks++;if(!value)throw new AssertionError(label);}
    private static void fails(Class<? extends Throwable> type,Runnable action){checks++;try{action.run();}catch(Throwable error){if(type.isInstance(error))return;throw new AssertionError(type.getName(),error);}throw new AssertionError("Expected "+type.getName());}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]).getParent().getParent(),data=Path.of(args[2]);maclauncher.android.framework.HostFilesystem.configure(runtime,data,data,data,"owned.parcel");
        System.setProperty("klepton.bridge",args[0]);System.load(args[0]);System.load(Path.of(args[0]).getParent().resolve("libnativebinding.dylib").toString());
        maclauncher.android.framework.JvmNativeMemory.configure(Path.of(args[0]).getParent().resolve("libandroid_runtime.dylib"));maclauncher.android.framework.JvmNativeMemory.initialize();
        var parcel=Parcel.obtain();var copy=Parcel.obtain();var values=Parcel.obtain();
        try{
            parcel.writeInt(0x12345678);parcel.writeLong(0x0102030405060708L);parcel.writeFloat(-1.25f);parcel.writeDouble(Math.PI);
            parcel.writeString16("A\u0000\ud800\ud83d\ude00");parcel.writeString8("A\u0000\ud800\ud83d\ude00");parcel.writeByteArray(new byte[]{1,2,3});parcel.writeBlob(new byte[]{5,6,7});
            byte[] bytes=parcel.marshall();check(bytes[0]==0x78&&bytes[3]==0x12&&bytes[4]==8&&bytes[11]==1,"little endian primitive wire");
            copy.unmarshall(bytes,0,bytes.length);copy.setDataPosition(0);
            check(copy.readInt()==0x12345678&&copy.readLong()==0x0102030405060708L,"integers");check(copy.readFloat()==-1.25f&&copy.readDouble()==Math.PI,"floating point");
            check(copy.readString16().equals("A\u0000\ud800\ud83d\ude00")&&copy.readString8().equals("A\u0000\ud800\ud83d\ude00"),"UTF16 and JNI modified UTF8");
            check(Arrays.equals(copy.createByteArray(),new byte[]{1,2,3})&&Arrays.equals(copy.readBlob(),new byte[]{5,6,7}),"padded arrays and in-place blobs");copy.enforceNoDataAvail();
            for(ByteBuffer buffer:new ByteBuffer[]{ByteBuffer.allocate(bytes.length+8),ByteBuffer.allocateDirect(bytes.length+8)}){
                buffer.position(3);parcel.marshall(buffer);check(buffer.position()==bytes.length+3,"ByteBuffer write position");buffer.limit(buffer.position()).position(3);copy.unmarshall(buffer);check(Arrays.equals(copy.marshall(),bytes),"heap and direct ByteBuffer data");
            }
            Bundle nested=new Bundle();nested.putString("name","nested");nested.putIntArray("array",new int[]{2,3});Bundle bundle=new Bundle();bundle.putBundle("child",nested);bundle.putParcelable("uri",android.net.Uri.parse("content://example/a%20b"));bundle.putStringArrayList("list",new ArrayList<>(List.of("one","two")));bundle.putSerializable("map",new HashMap<>(Map.of("answer",42)));
            Intent intent=new Intent("test.raw").putExtra("bundle",bundle);values.writeTypedObject(intent,0);values.setDataPosition(0);Intent restored=values.readTypedObject(Intent.CREATOR);
            Bundle result=restored.getBundleExtra("bundle");check(result.getBundle("child").getString("name").equals("nested"),"upstream lazy nested Bundle");
            check(result.getParcelable("uri",android.net.Uri.class).getPath().equals("/a b"),"upstream typed Parcelable");check(result.getStringArrayList("list").equals(List.of("one","two")),"upstream list values");check(((Map<?,?>)result.getSerializable("map")).get("answer").equals(42),"upstream Serializable JDK values");
            Bundle typed=new Bundle();typed.putByte("byte",(byte)-17);typed.putShort("short",(short)-400);typed.putChar("char",'猫');typed.putFloat("float",1.25f);typed.putBooleanArray("booleans",new boolean[]{true,false});typed.putCharArray("chars",new char[]{'猫','x'});typed.putSize("size",new android.util.Size(7,9));typed.putSizeF("sizeF",new android.util.SizeF(7.5f,9.5f));
            values.setDataSize(0);values.setDataPosition(0);values.writeBundle(typed);values.setDataPosition(0);Bundle decodedTypes=values.readBundle(RawParcelProbe.class.getClassLoader());
            check(decodedTypes.getByte("byte")==-17&&decodedTypes.getShort("short")==-400&&decodedTypes.getChar("char")=='猫'&&decodedTypes.getFloat("float")==1.25f,"upstream scalar Bundle transport");
            check(Arrays.equals(decodedTypes.getBooleanArray("booleans"),new boolean[]{true,false})&&Arrays.equals(decodedTypes.getCharArray("chars"),new char[]{'猫','x'})&&decodedTypes.getSize("size").equals(new android.util.Size(7,9))&&decodedTypes.getSizeF("sizeF").equals(new android.util.SizeF(7.5f,9.5f)),"upstream typed arrays and sizes");
            PersistableBundle persistent=new PersistableBundle();persistent.putLongArray("ids",new long[]{2,4});PersistableBundle deep=persistent.deepCopy();persistent.getLongArray("ids")[0]=9;check(deep.getLongArray("ids")[0]==2,"upstream persistent deep copy");
            for(java.io.Serializable value:List.of(new java.io.File("/private/value-only"),java.time.Instant.ofEpochSecond(123),new java.util.concurrent.atomic.AtomicInteger(19))){
                values.setDataSize(0);values.setDataPosition(0);values.writeSerializable(value);values.setDataPosition(0);var decoded=values.readSerializable(null,java.io.Serializable.class);
                check(decoded.getClass()==value.getClass()&&decoded.toString().equals(value.toString()),"original Java serialization without a host class filter");
            }
            try(var guestLoader=new java.net.URLClassLoader(new java.net.URL[]{Path.of(args[2]).toUri().toURL()},ClassLoader.getPlatformClassLoader())){
                var guest=(java.io.Serializable)guestLoader.loadClass("BundleGuestValue").getConstructor(String.class).newInstance("guest");
                values.setDataSize(0);values.setDataPosition(0);values.writeSerializable(guest);values.setDataPosition(0);var decoded=values.readSerializable(guestLoader,java.io.Serializable.class);
                check(decoded.getClass().getClassLoader()==guestLoader&&decoded.getClass().getField("name").get(decoded).equals("guest"),"upstream deserialization uses the app class loader");
            }
            values.setDataSize(0);Binder binder=new Binder("local");values.writeStrongBinder(binder);int objectSize=values.dataSize();check(objectSize==28&&values.hasBinders(),"local Binder reference: flat_binder_object plus the libbinder stability category");copy.setDataSize(0);copy.appendFrom(values,0,objectSize);values.recycle();values=Parcel.obtain();copy.setDataPosition(0);check(copy.readStrongBinder()==binder,"copied Binder lifetime");fails(RuntimeException.class,copy::marshall);
            Parcel partial=values;partial.appendFrom(copy,1,objectSize-1);check(!partial.hasBinders(),"partial byte copy does not acquire an incomplete Binder object");partial.setDataSize(0);partial.setDataPosition(0);
            values.writeInterfaceToken("owned.interface");check(values.replaceCallingWorkSourceUid(31)&&values.readCallingWorkSourceUid()==31,"real token work-source position");values.setDataPosition(0);values.enforceInterface("owned.interface");values.enforceNoDataAvail();
            values.setDataPosition(0);fails(SecurityException.class,()->partial.enforceInterface("wrong.interface"));
            Path file=Path.of(args[1]);Files.write(file,new byte[]{11,12,13});
            try(ParcelFileDescriptor original=ParcelFileDescriptor.open(file.toFile(),ParcelFileDescriptor.MODE_READ_ONLY)){
                values.setDataSize(0);values.writeFileDescriptor(original.getFileDescriptor());check(values.hasFileDescriptors(),"real descriptor retained");copy.setDataSize(0);copy.appendFrom(values,0,values.dataSize());values.recycle();values=Parcel.obtain();
            }
            copy.setDataPosition(0);try(var reader=new ParcelFileDescriptor.AutoCloseInputStream(copy.readFileDescriptor())){check(Arrays.equals(reader.readAllBytes(),new byte[]{11,12,13}),"descriptor survives original close and source recycle");}
            copy.setDataPosition(0);boolean old=values.pushAllowFds(false);Parcel noFds=values;fails(RuntimeException.class,()->noFds.appendFrom(copy,0,copy.dataSize()));values.restoreAllowFds(old);
            copy.setDataSize(0);check(!copy.hasFileDescriptors()&&!copy.hasBinders(),"truncation retires references");
            values.setDataSize(16*1024*1024+1);check(values.dataSize()==16*1024*1024+1,"native Parcel retains upstream size support");values.setDataSize(0);values.setDataPosition(0);check(values.readInt()==0,"upstream primitive read default on absent data");
        }finally{parcel.recycle();copy.recycle();values.recycle();}
        System.out.println("PASS "+checks+" raw AOSP Parcel, Bundle, typed serialization, local Binder and real descriptor checks");
    }
}
