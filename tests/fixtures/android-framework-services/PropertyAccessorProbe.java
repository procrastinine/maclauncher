import android.animation.ObjectAnimator;
import android.animation.PropertyValuesHolder;
import android.animation.TypeEvaluator;
import java.lang.reflect.*;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.HostLooper;
import java.util.*;

public class PropertyAccessorProbe {
 private static final class Target {
  private String value="old";private int reads,writes;
  public String getValue(){reads++;return value;}
  public void setValue(String value){writes++;this.value=value;}
 }
 private static final class OtherTarget {
  private String value="other";
  public String getValue(){return value;}
  public void setValue(String value){this.value=value;}
 }
 private static final TypeEvaluator<String> EVALUATOR=(fraction,start,end)->fraction<1?start:end;
 private static Method cached(String name,Class<?> type)throws Exception {
  Field field=PropertyValuesHolder.class.getDeclaredField(name);field.setAccessible(true);
  @SuppressWarnings("unchecked") var all=(HashMap<Class<?>,HashMap<String,Method>>)field.get(null);
  return all.get(type).get("value");
 }
 private static void check(boolean value,String text){if(!value)throw new AssertionError(text);}
 public static void main(String[] args)throws Exception {
  var looper=RuntimeFixture.initialize(args[0],args[1]);
  try {
   Target first=new Target();ObjectAnimator animation=ObjectAnimator.ofObject(first,"value",EVALUATOR,"new");
   animation.setCurrentFraction(0);check(first.reads>0&&first.value.equals("old"),"Original getter initial value");
   animation.setCurrentFraction(1);check(first.value.equals("new")&&first.writes>0,"Public setter on private target class");
   Method setter=cached("sSetterPropertyMap",Target.class),getter=cached("sGetterPropertyMap",Target.class);
   check(setter.canAccess(first)&&getter.canAccess(first),"Original cached accessors retain access adaptation");
   Target second=new Target();ObjectAnimator.ofObject(second,"value",EVALUATOR,"cached").setCurrentFraction(1);
   check(second.value.equals("cached"),"Cached access on another target instance");
   check(setter==cached("sSetterPropertyMap",Target.class)&&getter==cached("sGetterPropertyMap",Target.class),"Original Method cache identity preserved");
   OtherTarget other=new OtherTarget();ObjectAnimator.ofObject(other,"value",EVALUATOR,"separate").setCurrentFraction(1);
   check(other.value.equals("separate")&&cached("sSetterPropertyMap",OtherTarget.class)!=setter,"Target classes retain distinct original caches");
   Method setup=PropertyValuesHolder.class.getDeclaredMethod("setupSetterOrGetter",Class.class,HashMap.class,String.class,Class.class);setup.setAccessible(true);
   Object absent=setup.invoke(PropertyValuesHolder.ofObject("missing",EVALUATOR,"x"),Target.class,new HashMap<>(),"set",String.class);
   check(absent==null,"Absent accessor retains upstream null result");
   System.out.println("PASS original animation accessors, getter initialization, Method caches and missing accessor behavior");
  } finally { HostLooper.close(looper); }
 }
}
