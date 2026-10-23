import java.io.*;
import java.util.*;
import java.util.zip.*;
import org.objectweb.asm.*;
/** Reads actual archive declarations for offline component composition evidence. */
public final class FrameworkArtifactInventory {
  public static void main(String[] args)throws Exception {
    try (var output=new PrintWriter(new BufferedWriter(new OutputStreamWriter(System.out)));var zip=new ZipFile(args[0])) {
      for(var entries=zip.entries();entries.hasMoreElements();) {
        var entry=entries.nextElement();if(!entry.getName().endsWith(".class"))continue;
        try(var input=zip.getInputStream(entry)) {
          var reader=new ClassReader(input);String owner=reader.getClassName();output.println("C\t"+owner);
          reader.accept(new ClassVisitor(Opcodes.ASM9) {
            @Override public FieldVisitor visitField(int access,String name,String descriptor,String signature,Object value) {
              output.println("F\t"+owner+"#"+name+":"+descriptor);return null;
            }
            @Override public MethodVisitor visitMethod(int access,String name,String descriptor,String signature,String[] errors) {
              output.println("M\t"+owner+"#"+name+descriptor);
              if((access&Opcodes.ACC_NATIVE)!=0)output.println("N\t"+owner+"#"+name+descriptor);
              return null;
            }
          },ClassReader.SKIP_CODE|ClassReader.SKIP_DEBUG|ClassReader.SKIP_FRAMES);
        }
      }
    }
  }
}
