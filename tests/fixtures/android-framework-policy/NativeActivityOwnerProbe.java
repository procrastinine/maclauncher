import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

/** The complete original activity, including native declarations, survives normalization. */
public final class NativeActivityOwnerProbe {
    public static void main(String[] args)throws Exception {
        byte[] original;
        try(ZipFile archive=new ZipFile(args[0])) {
            try(var input=archive.getInputStream(archive.getEntry("android/app/NativeActivity.class"))) {
                original=input.readAllBytes();
            }
        }
        byte[] normalized=NativeBindings.transform(original);
        if(!Arrays.equals(original,normalized))throw new AssertionError("NativeActivity implementation or JNI declarations changed");
        ClassNode node=new ClassNode();new ClassReader(normalized).accept(node,0);
        long natives=node.methods.stream().filter(method->(method.access&Opcodes.ACC_NATIVE)!=0).count();
        if(natives==0)throw new AssertionError("Original NativeActivity has no native declarations");
        if(node.methods.stream().noneMatch(method->method.name.equals("onCreate")&&(method.access&Opcodes.ACC_NATIVE)==0))throw new AssertionError("Original lifecycle missing");
        System.out.println("PASS original NativeActivity bytes and "+natives+" JNI declarations preserved");
    }
}
