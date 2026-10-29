import android.util.IntArray;
import android.util.Pools;
import android.animation.FloatEvaluator;
import android.util.JsonReader;
import java.io.StringReader;

/** Exercises framework implementations absent from the host override sources. */
public final class FrameworkBaseProbe {
 static void check(boolean value,String label){if(!value)throw new AssertionError(label);}
 static void upstream(Class<?> type){check(type.getProtectionDomain().getCodeSource().getLocation().getPath().endsWith("android-framework.jar"),type+" did not come from AOSP");}
 public static void main(String[] args)throws Exception {
  for(Class<?> type:new Class<?>[]{JsonReader.class,IntArray.class,Pools.SimplePool.class,FloatEvaluator.class,android.os.ResultReceiver.class})upstream(type);
  IntArray values=new IntArray(0);for(int i=0;i<100;i++)values.add(i*2);values.add(10,91);values.remove(2);
  check(values.size()==100&&values.get(9)==91&&values.indexOf(198)==99,"AOSP array growth/insert/remove");
  var pool=new Pools.SimplePool<Object>(2);Object item=new Object();check(pool.acquire()==null&&pool.release(item)&&pool.acquire()==item,"AOSP pool");
  try(var json=new JsonReader(new StringReader("{\"values\":[17,true],\"skip\":{\"deep\":null}}"))){
   json.beginObject();check(json.nextName().equals("values"),"AOSP JSON key");json.beginArray();
   check(json.nextInt()==17&&json.nextBoolean(),"AOSP JSON values");json.endArray();json.nextName();json.skipValue();json.endObject();
  }
  check(new FloatEvaluator().evaluate(.25f,10,30)==15f,"AOSP animation arithmetic");
  final int[] result={0};new android.os.ResultReceiver(null){protected void onReceiveResult(int code,android.os.Bundle data){result[0]=code;}}.send(17,null);
  check(result[0]==17,"AOSP local result delivery");
  // Merely inspecting optional framework capabilities must not invoke Android JNI.
  check(java.lang.reflect.Modifier.isNative(android.os.SystemProperties.class.getDeclaredMethod("native_get",String.class,String.class).getModifiers()),"Native API unexpectedly replaced with a no-op");
  // Process identity queries use the original libcore JNI through the runtime's native binding.
  System.load(args[0]);System.load(args[1]);
  check(!android.os.Process.isIsolated(),"Host is not an Android isolated-service UID");
  var margins=new android.widget.FrameLayout.LayoutParams(30,40);margins.setMargins(1,2,3,4);
  check(margins.leftMargin==1&&margins.topMargin==2&&margins.rightMargin==3&&margins.bottomMargin==4,"Inherited layout margins");
  System.out.println("PASS full AOSP implementations, native boundary retention and existing host adapters");
 }
}
