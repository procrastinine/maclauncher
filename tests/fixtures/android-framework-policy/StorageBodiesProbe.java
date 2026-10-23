import java.util.*;
import java.util.zip.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

/** Compare executable Java bodies, rather than merely the existence of their APIs. */
public final class StorageBodiesProbe implements Opcodes {
    private static byte[] read(ZipFile archive,String name)throws Exception{try(var input=archive.getInputStream(archive.getEntry(name))){return input.readAllBytes();}}
    private static ClassNode parse(byte[] bytes){var node=new ClassNode();new ClassReader(bytes).accept(node,0);return node;}
    private static byte[] body(MethodNode method){
        var output=new ClassWriter(ClassWriter.COMPUTE_MAXS);output.visit(V21,ACC_PUBLIC,"Body",null,"java/lang/Object",null);
        method.accept(output.visitMethod(method.access,method.name,method.desc,method.signature,method.exceptions.toArray(String[]::new)));output.visitEnd();return output.toByteArray();
    }
    private static void same(MethodNode before,MethodNode after){if(!Arrays.equals(body(before),body(after)))throw new AssertionError("Upstream Java body changed: "+before.name+before.desc);}
    public static void main(String[] args)throws Exception{
        int checked=0;
        try(var archive=new ZipFile(args[0])){
            var methods=new HashMap<String,MethodNode>();
            byte[] storage=read(archive,"android/os/storage/StorageManager.class");
            if(!Arrays.equals(storage,FilesystemPortability.transform("android/os/storage/StorageManager.class",storage)))throw new AssertionError("StorageManager client must remain upstream");
            byte[] environment=read(archive,"android/os/Environment.class");var before=parse(environment);var after=parse(FilesystemPortability.transform("android/os/Environment.class",environment));methods.clear();for(var method:after.methods)methods.put(method.name+method.desc,method);
            for(var method:before.methods)if(method.name.startsWith("isExternalStorage")){same(method,Objects.requireNonNull(methods.get(method.name+method.desc)));checked++;}
        }
        System.out.println("PASS "+checked+" original Environment Java bodies, unmodified StorageManager client");
    }
}
