import java.nio.file.*;
import java.util.*;
import java.util.jar.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;
import org.objectweb.asm.tree.analysis.*;

public final class OriginalSpawnTransform {
    static ClassNode node(byte[] bytes){var node=new ClassNode();new ClassReader(bytes).accept(node,0);return node;}
    static Set<String> methods(ClassNode type){var result=new TreeSet<String>();for(var method:type.methods)result.add(method.name+method.desc);return result;}
    static List<Object> constants(MethodNode method){var result=new ArrayList<Object>();for(var instruction:method.instructions)if(instruction instanceof LdcInsnNode value)result.add(value.cst);return result;}
    static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        try(var jar=new JarFile(args[0])){
            for(String name:List.of("android/os/ZygoteProcess.class","android/app/LoadedApk.class","android/app/ActivityThread.class","android/os/Looper.class","android/view/ViewRootImpl.class","android/view/inputmethod/InputMethodManager.class","android/view/inputmethod/RemoteInputConnectionImpl.class","com/android/server/am/PendingIntentRecord.class","com/android/server/am/PendingIntentController.class","com/android/server/accounts/AccountManagerService$Lifecycle.class")){
                byte[] original;try(var input=jar.getInputStream(jar.getJarEntry(name))){original=input.readAllBytes();}
                byte[] transformed=name.equals("android/os/Looper.class")?MessageQueuePortability.transform(name,original):name.startsWith("android/view/")?UiPortability.transform(name,original):ServicePortability.transform(name,original);
                var before=node(original);var after=node(transformed);
                require(methods(before).equals(methods(after)),name+" retains every original member");
                for(var method:after.methods)if((method.access&(Opcodes.ACC_ABSTRACT|Opcodes.ACC_NATIVE))==0)
                    new Analyzer<>(new BasicVerifier()).analyze(after.name,method);
                if(name.contains("PendingIntent"))for(var method:after.methods)for(var instruction:method.instructions)
                    if(instruction instanceof MethodInsnNode call)require(!call.owner.contains("HostPendingIntent"),"original PendingIntent uses original service owners");
                if(name.contains("AccountManagerService$Lifecycle")){
                    int publications=0;
                    for(int i=0;i<before.methods.size();i++){
                        var originalCalls=new ArrayList<String>();var actualCalls=new ArrayList<String>();
                        for(var instruction:before.methods.get(i).instructions)if(instruction instanceof MethodInsnNode call)originalCalls.add(call.owner+"."+call.name+call.desc);
                        for(var instruction:after.methods.get(i).instructions)if(instruction instanceof MethodInsnNode call){
                            if(call.owner.equals("maclauncher/android/framework/HostAccounts")&&call.name.equals("published"))publications++;
                            else actualCalls.add(call.owner+"."+call.name+call.desc);
                        }
                        require(originalCalls.equals(actualCalls),"original account factory and user lifecycle remain intact");
                    }
                    require(publications==1,"one account publication privacy boundary");
                }
                if(name.contains("ZygoteProcess")){
                    var old=before.methods.stream().filter(value->value.name.equals("startViaZygote")).findFirst().orElseThrow();
                    var changed=after.methods.stream().filter(value->value.name.equals("startViaZygote")).findFirst().orElseThrow();
                    require(constants(old).equals(constants(changed)),"original complete zygote arguments survive unchanged");
                    int originalTransport=0,hostTransport=0;
                    for(var instruction:changed.instructions)if(instruction instanceof MethodInsnNode call){
                        if(call.name.equals("openZygoteSocketIfNeeded")||call.name.equals("zygoteSendArgsAndGetResult"))originalTransport++;
                        if(call.owner.equals("com/android/internal/os/HostZygote")&&call.name.equals("start"))hostTransport++;
                    }
                    require(originalTransport==0&&hostTransport==1,"one supervisor transport owns the original command");
                }
            }
        }
        System.out.println("PASS original process/binding/Looper members and verified transport bytecode");
    }
}
