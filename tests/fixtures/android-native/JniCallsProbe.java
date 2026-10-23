package probe;
public class JniCallsProbe {
 static final Object TOKEN=new Object();
 int constructed;static int observed;
 public JniCallsProbe(int value){constructed=value;}
 public Object objectValue(int value){return value==42?TOKEN:null;}
 public boolean booleanValue(int value){return value==42;}
 public byte byteValue(int value){return (byte)-value;}
 public char charValue(int value){return '\u03a9';}
 public short shortValue(int value){return -1234;}
 public int intValue(int value){return value+1;}
 public long longValue(int value){return 0x123456789L;}
 public float floatValue(int value){return 42.5f;}
 public double doubleValue(int value){return 84.5;}
 public void voidValue(int value){observed=value;}
 public static Object staticObjectValue(int value){return value==42?TOKEN:null;}
 public static boolean staticBooleanValue(int value){return value==42;}
 public static byte staticByteValue(int value){return (byte)-value;}
 public static char staticCharValue(int value){return '\u03a9';}
 public static short staticShortValue(int value){return -1234;}
 public static int staticIntValue(int value){return value+1;}
 public static long staticLongValue(int value){return 0x123456789L;}
 public static float staticFloatValue(int value){return 42.5f;}
 public static double staticDoubleValue(int value){return 84.5;}
 public static void staticVoidValue(int value){observed=value;}
 public void throwing(int value){throw new IllegalStateException("guest-jni-"+value);}
 public static JniCallsProbe child(){return new Child();}
 private static final class Child extends JniCallsProbe {Child(){super(0);}@Override public int intValue(int value){return value+9;}}
 static {System.load(System.getProperty("jni.calls.test"));}
 static native void run(Object token);
 static native void bounds(Class<?> many);
 static native void beginLifetimes();
 static native void threadLease();
 static native void detachedLifetimes();
 static native void finishLifetimes();
 static final java.util.concurrent.atomic.AtomicInteger retirements=new java.util.concurrent.atomic.AtomicInteger();
 static void retired(){retirements.incrementAndGet();}
 static int scalar(int value){return value;}
 static long mixed(int a,Object token,long b,double d,float f,int c,int e,int g,int h,Object second,double d2,double d3,double d4,double d5,double d6,double d7,double d8){
  if(a!=7||token!=TOKEN||b!=0x112233445566L||d!=3.5||f!=1.25f||c!=-17||e!=23||g!=31||h!=47||second!=TOKEN||d2!=2.5||d3!=4.5||d4!=6.5||d5!=8.5||d6!=10.5||d7!=12.5||d8!=14.5)throw new AssertionError("Mixed guest JNI register/stack values");
  return 0x123456789L;
 }
 public static void main(String[] args)throws Exception{
  run(TOKEN);bounds(Class.forName("probe.JniManyMethods"));
  beginLifetimes();
  for(int i=0;i<8;i++){Thread worker=new Thread(()->{for(int j=0;j<10;j++)threadLease();});worker.start();worker.join();}
  detachedLifetimes();finishLifetimes();
  if(retirements.get()!=10)throw new AssertionError("Foreign destructors lost live JNI: "+retirements.get());
  System.out.println("PASS guest JNI mixed register/stack plain/V/A; all ten return families, constructors, instance/static/nonvirtual; exceptions; ordinary host calls; 1050 distinct methods with bounded cache; JVM thread-end and detach preserve live JNI retirement");
 }
}
