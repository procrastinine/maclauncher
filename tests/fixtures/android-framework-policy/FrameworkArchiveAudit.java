import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

/** Test-only comparison against the publisher, independent of host replacements. */
public final class FrameworkArchiveAudit {
    private static ZipEntry declaration(ZipFile publisher,ZipEntry original,ZipFile artifact)throws Exception{
        String expected=switch(original.getName()){
            case "com/github/luben/zstd/ZstdInputStream.class" -> "d653e73c0d219cce2f08d7b78502f61e954211281141b5e42fb9f86f50f4defb";
            case "com/github/luben/zstd/ZstdOutputStream.class" -> "36ec5e209b07efd8f3795048cc62892da229eb8ce37ae67788aa6a0bcc294664";
            case "org/tukaani/xz/LZMAOutputStream.class" -> "e4ad65c31283cd632cd3168ac04345f2f908e2c402f09696470fa600ef498ba1";
            default -> null;
        };
        if(expected==null)return null;
        byte[] bytes=publisher.getInputStream(original).readAllBytes();
        if(!expected.equals(HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes))))return null;
        ZipEntry metadata=artifact.getEntry("META-INF/maclauncher/compile-only/"+original.getName());
        return metadata!=null&&Arrays.equals(bytes,artifact.getInputStream(metadata).readAllBytes())?metadata:null;
    }
    private static ClassNode read(ZipFile archive,ZipEntry entry)throws Exception {
        try(var input=archive.getInputStream(entry)){
            var node=new ClassNode();new ClassReader(input).accept(node,ClassReader.SKIP_CODE|ClassReader.SKIP_DEBUG|ClassReader.SKIP_FRAMES);return node;
        }
    }
    private static boolean compatible(int before,int after){
        int kind=Opcodes.ACC_STATIC|Opcodes.ACC_INTERFACE|Opcodes.ACC_ANNOTATION|Opcodes.ACC_ENUM;
        if((before&kind)!=(after&kind))return false;
        if((before&Opcodes.ACC_PUBLIC)!=0&&(after&Opcodes.ACC_PUBLIC)==0)return false;
        if((before&Opcodes.ACC_PROTECTED)!=0&&(after&(Opcodes.ACC_PUBLIC|Opcodes.ACC_PROTECTED))==0)return false;
        return !((before&Opcodes.ACC_ABSTRACT)==0&&(after&Opcodes.ACC_ABSTRACT)!=0)
            &&!((before&Opcodes.ACC_FINAL)==0&&(after&Opcodes.ACC_FINAL)!=0);
    }
    public static void main(String[] args)throws Exception {
        if(args.length!=2)throw new IllegalArgumentException("Expected publisher.jar adapted-framework.jar");
        List<String> failures=new ArrayList<>();int classes=0,methods=0;
        try(var upstream=new ZipFile(args[0]);var adapted=new ZipFile(args[1])){
            for(var entry:Collections.list(upstream.entries())){
                String name=entry.getName();
                // java.* is supplied by the JVM boot module, not a framework overlay.
                if(!name.endsWith(".class")||name.startsWith("java/"))continue;
                classes++;var actual=adapted.getEntry(name);
                if(actual==null)actual=declaration(upstream,entry,adapted);
                if(actual==null){failures.add("class "+name+" is missing");continue;}
                ClassNode original=read(upstream,entry),replacement=read(adapted,actual);
                if(!compatible(original.access,replacement.access)||!Objects.equals(original.superName,replacement.superName)||!replacement.interfaces.containsAll(original.interfaces))failures.add("class contract "+name);
                var members=new HashMap<String,MethodNode>();for(var method:replacement.methods)members.put(method.name+method.desc,method);
                for(var method:original.methods){
                    // VM initializer scheduling may move after native registration;
                    // it is not a callable method. Constructors remain mandatory.
                    if(method.name.equals("<clinit>"))continue;
                    methods++;var found=members.get(method.name+method.desc);
                    if(found==null||!compatible(method.access,found.access))failures.add("method "+original.name+"."+method.name+method.desc);
                }
                var fields=new HashMap<String,FieldNode>();for(var field:replacement.fields)fields.put(field.name+field.desc,field);
                for(var field:original.fields)if((field.access&(Opcodes.ACC_PUBLIC|Opcodes.ACC_PROTECTED))!=0){
                    var found=fields.get(field.name+field.desc);if(found==null||!compatible(field.access,found.access))failures.add("field "+original.name+"."+field.name+field.desc);
                }
            }
        }
        if(!failures.isEmpty())throw new AssertionError("Upstream APIs hidden by normalization ("+failures.size()+"):\n"+String.join("\n",failures));
        System.out.println("PASS publisher archive preserved: "+classes+" classes, "+methods+" methods; no missing-API exceptions");
    }
}
