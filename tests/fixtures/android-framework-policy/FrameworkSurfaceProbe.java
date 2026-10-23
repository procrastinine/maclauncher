import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.objectweb.asm.*;

public final class FrameworkSurfaceProbe {
 private static byte[] type(String name,String parent,int access,boolean constructor,boolean members){
  var out=new ClassWriter(0);out.visit(Opcodes.V21,access,name,null,parent,null);
  if(constructor)out.visitMethod(Opcodes.ACC_PUBLIC,"<init>","()V",null,null).visitEnd();
  if(members){out.visitMethod(Opcodes.ACC_PUBLIC,"inherited","()V",null,null).visitEnd();out.visitField(Opcodes.ACC_PROTECTED,"value","I",null,null).visitEnd();}
  out.visitEnd();return out.toByteArray();
 }
 private static int cases;
 private static void run(Path base,String name,byte[] replacement,boolean pass,String... details)throws Exception {
  Path folder=Files.createDirectories(base.resolve(name)),classes=Files.createDirectories(folder.resolve("classes/p"));
  Files.write(classes.resolve("Child.class"),replacement);
  Path report=folder.resolve("report.json");
  boolean okay=true;
  try{FrameworkSurfaceAudit.main(new String[]{base.resolve("upstream.jar").toString(),folder.resolve("classes").toString(),report.toString()});}
  catch(IllegalStateException expected){okay=false;}
  if(okay!=pass)throw new AssertionError(name+" result="+okay);
  String result=Files.readString(report);for(String detail:details)if(!result.contains(detail))throw new AssertionError(name+" lacks "+detail);
  cases++;
 }
 public static void main(String[] args)throws Exception {
  Path base=Files.createDirectories(Path.of(args[0]));
  try(var jar=new ZipOutputStream(Files.newOutputStream(base.resolve("upstream.jar")))){
   for(var item:Map.of("p/Parent",type("p/Parent","java/lang/Object",Opcodes.ACC_PUBLIC,true,true),"p/Child",type("p/Child","p/Parent",Opcodes.ACC_PUBLIC,true,false)).entrySet()){
    jar.putNextEntry(new ZipEntry(item.getKey()+".class"));jar.write(item.getValue());jar.closeEntry();
   }
  }
  run(base,"preserved",type("p/Child","p/Parent",Opcodes.ACC_PUBLIC,true,false),true);
  run(base,"lost-parent",type("p/Child","java/lang/Object",Opcodes.ACC_PUBLIC,true,false),false,"method p/Child.inherited()V","field p/Child.valueI");
  run(base,"lost-constructor",type("p/Child","p/Parent",Opcodes.ACC_PUBLIC,false,false),false,"method p/Child.<init>()V");
  run(base,"hidden-class",type("p/Child","p/Parent",0,true,false),false,"public class became inaccessible");
  run(base,"final-class",type("p/Child","p/Parent",Opcodes.ACC_PUBLIC|Opcodes.ACC_FINAL,true,false),false,"extensible class became final");
  run(base,"abstract-class",type("p/Child","p/Parent",Opcodes.ACC_PUBLIC|Opcodes.ACC_ABSTRACT,true,false),false,"concrete class became abstract");
  System.out.println("PASS "+cases+" framework surface audit cases: inheritance, constructors and class contracts without exclusions");
 }
}
