import java.nio.file.*;
import java.util.jar.*;
import org.objectweb.asm.*;

/** Independent registry fixture: complete, mixed, absent and helper-only owners. */
public final class NativeCatalogDeclarationsProbe implements Opcodes {
    private static void entry(JarOutputStream out,String name,boolean hasMethod,boolean nativeMethod)throws Exception{
        ClassWriter code=new ClassWriter(0);code.visit(V21,ACC_PUBLIC,name,null,"java/lang/Object",null);
        if(hasMethod){var method=code.visitMethod(ACC_PUBLIC|ACC_STATIC|(nativeMethod?ACC_NATIVE:0),"operation","()V",null,null);
            if(!nativeMethod){method.visitCode();method.visitInsn(RETURN);method.visitMaxs(0,0);}method.visitEnd();}
        code.visitEnd();out.putNextEntry(new JarEntry(name+".class"));out.write(code.toByteArray());out.closeEntry();
    }
    public static void main(String[] args)throws Exception{
        Path root=Path.of(args[0]);
        try(var original=new JarOutputStream(Files.newOutputStream(root.resolve("original.jar")));
            var adapted=new JarOutputStream(Files.newOutputStream(root.resolve("adapted.jar")))){
            entry(original,"a",true,true);entry(adapted,"a",true,false);
            entry(original,"android/util/Log",true,true);entry(adapted,"android/util/Log",true,false);
            entry(original,"android/util/Log$Nested",true,true);entry(adapted,"android/util/Log$Nested",true,true);
            entry(original,"future/publisher/Native$Nested",true,true);
            entry(original,"x/y/Z",false,false);entry(adapted,"x/y/Z",false,false);
        }
    }
}
