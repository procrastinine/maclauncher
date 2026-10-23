import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

/** Original loader classes plus the production JVM adaptation, not replacements. */
public final class DexLoadersProbe implements Opcodes {
 public static void main(String[] args)throws Exception{
  try(var source=new ZipFile(args[0])){
   var originals=new HashMap<String,ClassNode>();
   for(var entry:Collections.list(source.entries()))if(entry.getName().startsWith("dalvik/system/")&&entry.getName().endsWith(".class")){
    var type=new ClassNode();try(var input=source.getInputStream(entry)){new ClassReader(input).accept(type,0);}originals.put(type.name,type);
   }
   var parents=new HashMap<String,String>();originals.forEach((name,type)->parents.put(name,type.superName));
   FrameworkImplementationAudit.loaderHierarchy(parents);DexPortability.initialize(List.of(source));int count=0;
   for(var original:originals.values()){
    boolean loader=false;for(String at=original.name;at!=null;at=parents.get(at))if(at.equals("java/lang/ClassLoader")){loader=true;break;}
    if(!loader)continue;
    byte[] bytes;try(var input=source.getInputStream(source.getEntry(original.name+".class"))){bytes=DexPortability.transform(original.name+".class",input.readAllBytes());}
    var adapted=new ClassNode();new ClassReader(bytes).accept(adapted,0);
    var init=adapted.methods.stream().filter(method->method.name.equals("<clinit>")).findFirst().orElseThrow();
    long registrations=0;for(var node:init.instructions)if(node instanceof MethodInsnNode call&&call.owner.equals(original.name)&&call.name.equals("registerAsParallelCapable")&&call.desc.equals("()Z"))registrations++;
    if(registrations!=1)throw new AssertionError("Exactly one JVM opt-in: "+original.name);
    for(var method:original.methods){
     var actual=adapted.methods.stream().filter(m->m.name.equals(method.name)&&m.desc.equals(method.desc)).findFirst().orElseThrow();
     String problem=FrameworkImplementationAudit.compare(original.name,method,actual);
     if(problem!=null)throw new AssertionError(original.name+"."+method.name+": "+problem);
    }
    Path output=Path.of(args[1],original.name+".class");Files.createDirectories(output.getParent());Files.write(output,bytes);count++;
   }
   if(count==0)throw new AssertionError("No original DEX loaders inspected");
   System.out.println("PASS original DEX-loader hierarchy: "+count+" classes and all original methods preserved");
  }
 }
}
