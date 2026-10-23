package owned.dynamic;
public final class Marker {
 public static void verify()throws Exception{
  if(NativeChild.value()!=73)throw new AssertionError("native exports before JNI_OnLoad");
  java.util.concurrent.atomic.AtomicReference<Throwable> failure=new java.util.concurrent.atomic.AtomicReference<>();
  Thread worker=new Thread(()->{try{Class<?> late=Class.forName("owned.dynamic.Late",true,Marker.class.getClassLoader());if((int)late.getMethod("value").invoke(null)!=74)throw new AssertionError("late export");}catch(Throwable error){failure.set(error);}},"onload-class-definition");
  worker.setDaemon(true);worker.start();worker.join(3000);
  if(worker.isAlive())throw new AssertionError("JNI_OnLoad held a loader lock across worker class definition");
  if(failure.get()!=null)throw new AssertionError("late native binding",failure.get());
 }
}
