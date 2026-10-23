import java.net.*;
import java.nio.file.*;
public class VerifyArrays {
 public static void main(String[] args)throws Exception {
  try(var loader=new URLClassLoader(new URL[]{Path.of(args[0]).toUri().toURL()})){
   Class<?> cls=loader.loadClass("fixture.FilledArrays");
   for(String name:new String[]{"discard","discardRange"})for(int branch:new int[]{0,1})
    if(!Integer.valueOf(7).equals(cls.getMethod(name,int.class).invoke(null,branch)))throw new AssertionError(name);
   for(String name:new String[]{"retained","retainedRange"}){
    Object[] value=(Object[])cls.getMethod(name).invoke(null);
    if(value.length!=1||value[0]!=null)throw new AssertionError(name);
   }
  }
  System.out.println("PASS filled arrays discard unused results and retain consumed results in both DEX forms");
 }
}
