import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

/** Test-only check for host replacements that silently remove upstream APIs. */
public final class FrameworkSurfaceAudit implements AutoCloseable {
    private record Key(String kind,String owner,String name,String descriptor) {
        public String toString(){return kind+" "+owner+"."+name+descriptor;}
    }
    private final ZipFile archive;
    private final Map<String,ClassNode> host=new TreeMap<>(),upstream=new HashMap<>(),platform=new HashMap<>();
    private final List<String> failures=new ArrayList<>();
    private int checkedClasses,checkedMethods,checkedFields;
    private FrameworkSurfaceAudit(Path framework,Path classes)throws IOException {
        archive=new ZipFile(framework.toFile());
        try(var files=Files.walk(classes)) {
            for(Path file:files.filter(p->p.toString().endsWith(".class")).sorted().toList()) {
                var value=read(Files.readAllBytes(file));host.put(value.name,value);
            }
        }
    }

    private static ClassNode read(byte[] bytes) {
        var node=new ClassNode(Opcodes.ASM9);
        new ClassReader(bytes).accept(node,ClassReader.SKIP_CODE|ClassReader.SKIP_DEBUG|ClassReader.SKIP_FRAMES);
        return node;
    }
    private ClassNode upstream(String name)throws IOException {
        if(upstream.containsKey(name))return upstream.get(name);
        var entry=archive.getEntry(name+".class");if(entry==null)return null;
        try(var input=archive.getInputStream(entry)) {var node=read(input.readAllBytes());upstream.put(name,node);return node;}
    }
    private ClassNode actual(String name)throws IOException {
        var node=host.get(name);if(node!=null)return node;
        return reference(name);
    }
    private ClassNode reference(String name)throws IOException {
        var node=upstream(name);if(node!=null)return node;
        if(platform.containsKey(name))return platform.get(name);
        try(var input=ClassLoader.getPlatformClassLoader().getResourceAsStream(name+".class")) {
            node=input==null?null:read(input.readAllBytes());platform.put(name,node);return node;
        }
    }
    private static boolean exposed(int access){return (access&(Opcodes.ACC_PUBLIC|Opcodes.ACC_PROTECTED))!=0;}
    private static boolean compatible(int original,int replacement) {
        if((original&Opcodes.ACC_STATIC)!=(replacement&Opcodes.ACC_STATIC))return false;
        if((original&Opcodes.ACC_FINAL)==0&&(replacement&Opcodes.ACC_FINAL)!=0)return false;
        if((original&Opcodes.ACC_ABSTRACT)==0&&(replacement&Opcodes.ACC_ABSTRACT)!=0)return false;
        return (original&Opcodes.ACC_PUBLIC)!=0?(replacement&Opcodes.ACC_PUBLIC)!=0:exposed(replacement);
    }
    private MethodNode method(String owner,String name,String descriptor,Set<String> visited)throws IOException {
        if(!visited.add(owner))return null;var node=actual(owner);if(node==null)return null;
        for(var method:node.methods)if(method.name.equals(name)&&method.desc.equals(descriptor))return method;
        if(name.equals("<init>"))return null;
        if(node.superName!=null){var found=method(node.superName,name,descriptor,visited);if(found!=null)return found;}
        for(String iface:node.interfaces){var found=method(iface,name,descriptor,visited);if(found!=null&&(found.access&(Opcodes.ACC_STATIC|Opcodes.ACC_PRIVATE))==0)return found;}
        return null;
    }
    private void surface(String owner,boolean root,Map<String,MethodNode> methods,Map<String,FieldNode> fields,Set<String> visited)throws IOException {
        if(!visited.add(owner))return;var node=reference(owner);if(node==null)return;
        for(var member:node.methods)if(exposed(member.access)&&
                (root||(!member.name.equals("<init>")&&((node.access&Opcodes.ACC_INTERFACE)==0||(member.access&Opcodes.ACC_STATIC)==0))))
            methods.putIfAbsent(member.name+member.desc,member);
        for(var member:node.fields)if(exposed(member.access))fields.putIfAbsent(member.name+member.desc,member);
        if(node.superName!=null&&(node.access&Opcodes.ACC_INTERFACE)==0)surface(node.superName,false,methods,fields,visited);
        for(String iface:node.interfaces)surface(iface,false,methods,fields,visited);
    }
    private FieldNode field(String owner,String name,String descriptor,Set<String> visited)throws IOException {
        if(!visited.add(owner))return null;var node=actual(owner);if(node==null)return null;
        for(var field:node.fields)if(field.name.equals(name)&&field.desc.equals(descriptor))return field;
        for(String iface:node.interfaces){var found=field(iface,name,descriptor,visited);if(found!=null)return found;}
        return node.superName==null?null:field(node.superName,name,descriptor,visited);
    }
    private void missing(Key key,String detail) {
        failures.add(key+" — "+detail);
    }
    private void audit()throws IOException {
        for(var entry:host.entrySet()) {
            var original=upstream(entry.getKey());if(original==null)continue;
            var replacement=entry.getValue();checkedClasses++;
            if((original.access&Opcodes.ACC_INTERFACE)!=(replacement.access&Opcodes.ACC_INTERFACE))
                failures.add("class "+entry.getKey()+" — upstream interface/class kind changed");
            if((original.access&Opcodes.ACC_PUBLIC)!=0&&(replacement.access&Opcodes.ACC_PUBLIC)==0)
                failures.add("class "+entry.getKey()+" — public class became inaccessible");
            if((original.access&Opcodes.ACC_FINAL)==0&&(replacement.access&Opcodes.ACC_FINAL)!=0)
                failures.add("class "+entry.getKey()+" — extensible class became final");
            if((original.access&Opcodes.ACC_ABSTRACT)==0&&(replacement.access&Opcodes.ACC_ABSTRACT)!=0)
                failures.add("class "+entry.getKey()+" — concrete class became abstract");
            Map<String,MethodNode> methods=new LinkedHashMap<>();Map<String,FieldNode> fields=new LinkedHashMap<>();
            surface(original.name,true,methods,fields,new HashSet<>());
            for(var m:methods.values()) {
                checkedMethods++;var found=method(original.name,m.name,m.desc,new HashSet<>());
                if(found==null||!compatible(m.access,found.access))
                    missing(new Key("method",original.name,m.name,m.desc),found==null?"missing":"visibility, final/abstract or static/instance kind changed");
            }
            for(var f:fields.values()) {
                checkedFields++;var found=field(original.name,f.name,f.desc,new HashSet<>());
                if(found==null||!compatible(f.access,found.access))
                    missing(new Key("field",original.name,f.name,f.desc),found==null?"missing":"visibility, final or static/instance kind changed");
            }
        }
    }
    private static String quote(String value) {
        return '"'+value.replace("\\","\\\\").replace("\"","\\\"").replace("\n","\\n").replace("\r","\\r").replace("\t","\\t")+'"';
    }
    private static String array(List<String> values){return "["+String.join(",",values.stream().map(FrameworkSurfaceAudit::quote).toList())+"]";}
    private void report(Path output)throws IOException {
        Files.writeString(output,"{\"schemaVersion\":1,\"checkedHostClasses\":"+checkedClasses+",\"checkedMethods\":"+checkedMethods
            +",\"checkedFields\":"+checkedFields+",\"failures\":"+array(failures)+"}\n");
    }
    public void close()throws IOException {archive.close();}
    public static void main(String[] args)throws Exception {
        if(args.length!=3)throw new IllegalArgumentException("Expected framework.jar host-classes report.json");
        try(var audit=new FrameworkSurfaceAudit(Path.of(args[0]),Path.of(args[1]))) {
            audit.audit();audit.report(Path.of(args[2]));
            if(!audit.failures.isEmpty())throw new IllegalStateException("Host replacements hide or change "+audit.failures.size()+" upstream APIs; see "+args[2]);
            System.out.println("PASS complete upstream API surface: "+audit.checkedClasses+" host classes, "+audit.checkedMethods+" methods, "+audit.checkedFields+" fields");
        }
    }
}
