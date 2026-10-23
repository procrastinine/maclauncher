import java.nio.file.Files;
import java.nio.file.Paths;
public final class ArtSharedJniProbe {
 public static native int dependency();
 public static native long asset(Object manager,String name,long size);
 private static native void open(byte[] image);
 private static native void close();
 private static native long roundtrip(byte narrow,short signed16,long value,float single,double wide,String text,int[] array);
 private static native int nested(int value);
 static long callback(long value,float single,double wide,String text,int[] array) {
  if(single!=1.25f||wide!=3.5||!text.equals("art references")||array[0]!=18)throw new AssertionError("JNI callback arguments");
  System.gc();
  if(value<0)throw new IllegalArgumentException("original ART exception");
  return value+nested(6)+array[0];
 }
 private static void check() {
  long base=0x123456789abcdef0L;
  long result=roundtrip((byte)-91,(short)-12345,base,1.25f,3.5,"art references",new int[]{11,22});
  if(result!=base+36)throw new AssertionError("JNI width/closure result "+result);
  try{roundtrip((byte)-91,(short)-12345,-1,1.25f,3.5,"art references",new int[]{11});throw new AssertionError("Missing exception");}
  catch(IllegalArgumentException expected){if(!expected.getMessage().equals("original ART exception"))throw expected;}
 }
 public static void main(String[] arguments)throws Exception {
  if(arguments[0].indexOf('/')>=0)System.load(arguments[0]);else System.loadLibrary(arguments[0]);
  if(arguments.length>1)open(Files.readAllBytes(Paths.get(arguments[1])));
  try{check();Throwable[] failure={null};Thread worker=new Thread(()->{try{check();}catch(Throwable e){failure[0]=e;}});worker.start();worker.join();if(failure[0]!=null)throw new AssertionError(failure[0]);}
  finally{if(arguments.length>1)close();}
  System.out.println("PASS shared ARM32 JNI, ELF, references, A/V calls, closures, GC, exceptions and thread retirement: "+System.getProperty("java.vm.name"));
 }
}
