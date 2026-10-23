import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

/** Test-only detection of alternate framework algorithms hidden under differently named subclasses. */
public final class FrameworkSubclassAudit implements AutoCloseable {
    private final ZipFile publisher;
    private final Map<String,ClassNode> hosts=new TreeMap<>(),upstream=new HashMap<>();
    private final List<String> failures=new ArrayList<>(),callbacks=new ArrayList<>();
    private int examined,interfaceEndpoints,abstractImplementations,upstreamForwarders;
    // These are concrete, intentional provider callbacks, not manager/client APIs.
    // Scope each exception to both implementing class and exact inherited method.
    private static final Map<String,String> PLATFORM_CALLBACKS=Map.ofEntries(
        Map.entry("maclauncher/android/framework/HostPackages$Resolver -> com/android/server/IntentResolver.newResult(Lcom/android/server/pm/Computer;Ljava/lang/Object;IIJ)Ljava/lang/Object;", "IntentResolver result adapter maps inspected local component and user state to ResolveInfo; default returns the filter object"),
        Map.entry("maclauncher/android/framework/HostPackages$Resolver -> com/android/server/IntentResolver.allowFilterResult(Ljava/lang/Object;Ljava/util/List;)Z", "IntentResolver result adapter identifies duplicate local components when multiple manifest filters match; default accepts every filter"),
        Map.entry("maclauncher/android/framework/HostPackages$Resolver -> com/android/server/IntentResolver.sortResults(Ljava/util/List;)V", "IntentResolver typed result adapter delegates ordering to the original ComponentResolver.RESOLVE_PRIORITY_SORTER; default comparator accepts IntentFilter values"),
        Map.entry("maclauncher/android/web/WebKitStorage -> android/webkit/WebStorage.getOrigins(Landroid/webkit/ValueCallback;)V", "WebViewFactoryProvider.getWebStorage returns the browser engine storage endpoint; original class methods are provider extension bodies"),
        Map.entry("maclauncher/android/web/WebKitStorage -> android/webkit/WebStorage.getUsageForOrigin(Ljava/lang/String;Landroid/webkit/ValueCallback;)V", "WebViewFactoryProvider.getWebStorage returns the browser engine storage endpoint; original class methods are provider extension bodies"),
        Map.entry("maclauncher/android/web/WebKitStorage -> android/webkit/WebStorage.getQuotaForOrigin(Ljava/lang/String;Landroid/webkit/ValueCallback;)V", "WebViewFactoryProvider.getWebStorage returns the browser engine storage endpoint; original class methods are provider extension bodies"),
        Map.entry("maclauncher/android/web/WebKitStorage -> android/webkit/WebStorage.setQuotaForOrigin(Ljava/lang/String;J)V", "WebViewFactoryProvider.getWebStorage returns the browser engine storage endpoint; original class methods are provider extension bodies"),
        Map.entry("maclauncher/android/web/WebKitStorage -> android/webkit/WebStorage.deleteOrigin(Ljava/lang/String;)V", "WebViewFactoryProvider.getWebStorage returns the browser engine storage endpoint; original class methods are provider extension bodies"),
        Map.entry("maclauncher/android/web/WebKitStorage -> android/webkit/WebStorage.deleteAllData()V", "WebViewFactoryProvider.getWebStorage returns the browser engine storage endpoint; original class methods are provider extension bodies"),
        Map.entry("maclauncher/android/web/WebKitFactory$1 -> android/webkit/GeolocationPermissions.getOrigins(Landroid/webkit/ValueCallback;)V", "WebViewFactoryProvider.getGeolocationPermissions returns per-origin browser permission state; original class methods are provider extension bodies, location access remains manually granted"),
        Map.entry("maclauncher/android/web/WebKitFactory$1 -> android/webkit/GeolocationPermissions.getAllowed(Ljava/lang/String;Landroid/webkit/ValueCallback;)V", "WebViewFactoryProvider.getGeolocationPermissions returns per-origin browser permission state; original class methods are provider extension bodies, location access remains manually granted"),
        Map.entry("maclauncher/android/web/WebKitFactory$1 -> android/webkit/GeolocationPermissions.allow(Ljava/lang/String;)V", "WebViewFactoryProvider.getGeolocationPermissions returns per-origin browser permission state; original class methods are provider extension bodies, location access remains manually granted"),
        Map.entry("maclauncher/android/web/WebKitFactory$1 -> android/webkit/GeolocationPermissions.clear(Ljava/lang/String;)V", "WebViewFactoryProvider.getGeolocationPermissions returns per-origin browser permission state; original class methods are provider extension bodies, location access remains manually granted"),
        Map.entry("maclauncher/android/web/WebKitFactory$1 -> android/webkit/GeolocationPermissions.clearAll()V", "WebViewFactoryProvider.getGeolocationPermissions returns per-origin browser permission state; original class methods are provider extension bodies, location access remains manually granted")
    );
    private FrameworkSubclassAudit(Path framework,Path classes)throws IOException{
        publisher=new ZipFile(framework.toFile());
        try(var files=Files.walk(classes)){for(Path path:files.filter(p->p.toString().endsWith(".class")).sorted().toList()){ClassNode node=read(Files.readAllBytes(path));hosts.put(node.name,node);}}
    }
    private static ClassNode read(byte[] bytes){ClassNode node=new ClassNode();new ClassReader(bytes).accept(node,ClassReader.SKIP_DEBUG|ClassReader.SKIP_FRAMES);return node;}
    private ClassNode reference(String name)throws IOException{
        if(upstream.containsKey(name))return upstream.get(name);var entry=publisher.getEntry(name+".class");ClassNode node=null;
        if(entry!=null)try(var input=publisher.getInputStream(entry)){node=read(input.readAllBytes());}
        upstream.put(name,node);return node;
    }
    private ClassNode actual(String name)throws IOException{ClassNode node=hosts.get(name);return node==null?reference(name):node;}
    private boolean binderInterface(String name,Set<String> visited)throws IOException{
        if(name.equals("android/os/IInterface"))return true;if(!visited.add(name))return false;ClassNode node=actual(name);if(node==null)return false;
        for(String parent:node.interfaces)if(binderInterface(parent,visited))return true;return false;
    }
    private boolean endpointContract(String name,String method,String desc,Set<String> visited)throws IOException{
        if(!visited.add(name))return false;ClassNode node=actual(name);if(node==null)return false;
        if((node.access&Opcodes.ACC_INTERFACE)!=0&&reference(name)!=null&&binderInterface(name,new HashSet<>()))for(MethodNode candidate:node.methods)if(candidate.name.equals(method)&&candidate.desc.equals(desc))return true;
        for(String parent:node.interfaces)if(endpointContract(parent,method,desc,visited))return true;
        return node.superName!=null&&endpointContract(node.superName,method,desc,visited);
    }
    private static String packageName(String name){int end=name.lastIndexOf('/');return end<0?"":name.substring(0,end);}
    private static boolean inheritedBy(ClassNode host,ClassNode owner,MethodNode method){return (method.access&(Opcodes.ACC_PRIVATE|Opcodes.ACC_STATIC))==0&&((method.access&(Opcodes.ACC_PUBLIC|Opcodes.ACC_PROTECTED))!=0||packageName(host.name).equals(packageName(owner.name)));}
    // javac exposes inherited public methods of a package-private superclass
    // through synthetic access bridges. Verify the complete forwarding body;
    // synthetic/bridge flags alone never excuse an alternate implementation.
    private static boolean originalAccessForwarder(ClassNode host,MethodNode method,ClassNode owner){
        int required=Opcodes.ACC_PUBLIC|Opcodes.ACC_SYNTHETIC|Opcodes.ACC_BRIDGE;
        if((method.access&~Opcodes.ACC_VARARGS)!=required||(owner.access&Opcodes.ACC_PUBLIC)!=0
            ||!owner.name.equals(host.superName)||!method.tryCatchBlocks.isEmpty())return false;
        var code=new ArrayList<AbstractInsnNode>();for(var instruction:method.instructions)if(instruction.getOpcode()>=0)code.add(instruction);
        Type[] arguments=Type.getArgumentTypes(method.desc);
        if(code.size()!=arguments.length+3)return false;
        if(!(code.get(0) instanceof VarInsnNode receiver)||receiver.getOpcode()!=Opcodes.ALOAD||receiver.var!=0)return false;
        int slot=1,index=1;
        for(Type argument:arguments){
            if(!(code.get(index++) instanceof VarInsnNode load)||load.getOpcode()!=argument.getOpcode(Opcodes.ILOAD)||load.var!=slot)return false;
            slot+=argument.getSize();
        }
        if(!(code.get(index++) instanceof MethodInsnNode call)||call.getOpcode()!=Opcodes.INVOKESPECIAL||call.itf
            ||!call.owner.equals(owner.name)||!call.name.equals(method.name)||!call.desc.equals(method.desc))return false;
        return code.get(index) instanceof InsnNode&&code.get(index).getOpcode()==Type.getReturnType(method.desc).getOpcode(Opcodes.IRETURN);
    }
    private void declaration(ClassNode host,MethodNode method,ClassNode owner,MethodNode inherited)throws IOException{
        examined++;
        if((inherited.access&(Opcodes.ACC_ABSTRACT|Opcodes.ACC_NATIVE))!=0){abstractImplementations++;return;}
        if(originalAccessForwarder(host,method,owner)){upstreamForwarders++;return;}
        if(endpointContract(host.name,method.name,method.desc,new HashSet<>())){interfaceEndpoints++;return;}
        String key=host.name+" -> "+owner.name+"."+method.name+method.desc;
        String purpose=PLATFORM_CALLBACKS.get(key);
        if(purpose==null)failures.add(key);else callbacks.add(key+" : "+purpose);
    }
    private void defaultInterfaces(ClassNode host,MethodNode method,String name,Set<String> visited)throws IOException{
        if(!visited.add(name))return;ClassNode owner=actual(name);if(owner==null)return;
        if((owner.access&Opcodes.ACC_INTERFACE)!=0&&reference(name)!=null)for(MethodNode candidate:owner.methods)
            if(candidate.name.equals(method.name)&&candidate.desc.equals(method.desc)&&inheritedBy(host,owner,candidate)&&(candidate.access&(Opcodes.ACC_ABSTRACT|Opcodes.ACC_NATIVE))==0)declaration(host,method,owner,candidate);
        for(String parent:owner.interfaces)defaultInterfaces(host,method,parent,visited);
        if(owner.superName!=null)defaultInterfaces(host,method,owner.superName,visited);
    }
    private void inspect()throws IOException{
        for(ClassNode host:hosts.values())for(MethodNode method:host.methods){
            if(method.name.startsWith("<")||(method.access&(Opcodes.ACC_PRIVATE|Opcodes.ACC_STATIC))!=0)continue;
            Set<String> visited=new HashSet<>();String parent=host.superName;
            while(parent!=null&&visited.add(parent)){
                ClassNode node=actual(parent);if(node==null)break;
                MethodNode inherited=null;for(MethodNode candidate:node.methods)if(candidate.name.equals(method.name)&&candidate.desc.equals(method.desc)&&inheritedBy(host,node,candidate)){inherited=candidate;break;}
                if(inherited!=null){
                    if(reference(node.name)!=null){
                        declaration(host,method,node,inherited);
                    }
                    // An owned intermediate override does not hide an older AOSP ancestor.
                    if(reference(node.name)!=null)break;
                }
                parent=node.superName;
            }
            defaultInterfaces(host,method,host.name,new HashSet<>());
        }
    }
    private static String quote(String value){return '"'+value.replace("\\","\\\\").replace("\"","\\\"").replace("\n","\\n")+'"';}
    private static String array(List<String> values){return "["+String.join(",",values.stream().map(FrameworkSubclassAudit::quote).toList())+"]";}
    public void close()throws IOException{publisher.close();}
    public static List<String> check(Path framework,Path classes)throws IOException{try(var audit=new FrameworkSubclassAudit(framework,classes)){audit.inspect();return List.copyOf(audit.failures);}}
    public static void main(String[] args)throws Exception{
        if(args.length!=3)throw new IllegalArgumentException("Expected publisher.jar host-classes report.json");
        try(var audit=new FrameworkSubclassAudit(Path.of(args[0]),Path.of(args[1]))){audit.inspect();Files.writeString(Path.of(args[2]),"{\"examined\":"+audit.examined+",\"interfaceEndpoints\":"+audit.interfaceEndpoints+",\"abstractOrNativeImplementations\":"+audit.abstractImplementations+",\"upstreamAccessForwarders\":"+audit.upstreamForwarders+",\"documentedCallbacks\":"+array(audit.callbacks)+",\"failures\":"+array(audit.failures)+"}\n");
            if(!audit.failures.isEmpty())throw new IllegalStateException("Concrete upstream Java overrides: "+String.join("; ",audit.failures));
            System.out.println("PASS no alternate concrete framework algorithms: "+audit.examined+" inherited methods checked");
        }
    }
}
