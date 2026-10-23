package maclauncher.build;
import com.android.tools.smali.dexlib2.*;
import com.android.tools.smali.dexlib2.iface.*;
import com.android.tools.smali.dexlib2.iface.instruction.*;
import com.android.tools.smali.dexlib2.iface.reference.MethodReference;
import com.android.tools.smali.dexlib2.immutable.*;
import com.android.tools.smali.dexlib2.immutable.instruction.*;
import com.android.tools.smali.dexlib2.rewriter.*;
import java.nio.file.*;
import java.util.*;

/** Restore only invocation opcode/reference; canonical bytes must then match.
 * This detects altered arguments, registers, branches, handlers or API metadata. */
public final class DexServiceCallsProbe {
 static int changed;static Set<String> methods=new TreeSet<>();
 static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
 static Method restore(Method original,Method actual){
  if(original.getImplementation()==null)return actual;
  List<Instruction> before=new ArrayList<>(),after=new ArrayList<>();original.getImplementation().getInstructions().forEach(before::add);actual.getImplementation().getInstructions().forEach(after::add);
  check(before.size()==after.size(),"Original instruction count changed: "+DexBodies.key(original));
  boolean restored=false;
  for(int i=0;i<before.size();i++){
   var target=DexServiceCalls.target(original,before.get(i));if(target==null)continue;var current=after.get(i);
   check(current.getOpcode()==Opcode.INVOKE_STATIC||current.getOpcode()==Opcode.INVOKE_STATIC_RANGE,"Expected static service destination");
   var reference=(MethodReference)((ReferenceInstruction)current).getReference();check(reference.equals(target.reference()),"Wrong shared destination");
   var old=((ReferenceInstruction)before.get(i)).getReference();
   if(current instanceof FiveRegisterInstruction c)after.set(i,new ImmutableInstruction35c(before.get(i).getOpcode(),c.getRegisterCount(),c.getRegisterC(),c.getRegisterD(),c.getRegisterE(),c.getRegisterF(),c.getRegisterG(),old));
   else{var c=(RegisterRangeInstruction)current;after.set(i,new ImmutableInstruction3rc(before.get(i).getOpcode(),c.getStartRegister(),c.getRegisterCount(),old));}
   restored=true;changed++;methods.add(reference.getName());
  }
  if(!restored)return actual;
  var body=actual.getImplementation();return new ImmutableMethod(actual.getDefiningClass(),actual.getName(),actual.getParameters(),actual.getReturnType(),actual.getAccessFlags(),actual.getAnnotations(),actual.getHiddenApiRestrictions(),new ImmutableMethodImplementation(body.getRegisterCount(),after,body.getTryBlocks(),body.getDebugItems()));
 }
 public static void main(String[] args)throws Exception{
  var before=DexFileFactory.loadDexContainer(Path.of(args[0]).toFile(),null);var after=DexFileFactory.loadDexContainer(Path.of(args[1]).toFile(),null);int classes=0;
  check(before.getDexEntryNames().equals(after.getDexEntryNames()),"DEX archive changed");
  for(String entry:before.getDexEntryNames()){
   var original=before.getEntry(entry).getDexFile();var actual=after.getEntry(entry).getDexFile();Map<String,Method> methods=new HashMap<>();
   for(ClassDef type:original.getClasses()){classes++;for(Method method:type.getMethods())methods.put(DexBodies.key(method),method);}
   DexRewriter restore=new DexRewriter(new RewriterModule(){@Override public Rewriter<Method> getMethodRewriter(Rewriters rewriters){return method->restore(Objects.requireNonNull(methods.get(DexBodies.key(method))),method);}});
   check(Arrays.equals(DexBodiesProbe.canonical(original),DexBodiesProbe.canonical(restore.getDexFileRewriter().rewrite(actual))),"Original service arguments/flow/API metadata changed: "+entry);
  }
  check(changed>0&&methods.containsAll(Set.of("startActivityInPackage","startActivitiesInPackage","sendActivityResult","broadcastIntentInPackage","startServiceInPackage","remove")),"Complete PendingIntent destination family absent: "+methods);
  System.out.println("PASS "+changed+" shared PendingIntent calls across "+classes+" original service classes; arguments, branches, handlers and hidden API metadata preserved; "+methods);
 }
}
