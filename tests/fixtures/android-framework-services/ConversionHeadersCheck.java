import java.util.*;
import java.util.zip.*;
import org.objectweb.asm.*;

public final class ConversionHeadersCheck {
    private static Map<String,List<String>> declarations(String file,boolean headers)throws Exception {
        var result=new TreeMap<String,List<String>>();
        try(var zip=new ZipFile(file)){
            for(var entry:Collections.list(zip.entries()))if(entry.getName().endsWith(".class")){
                var members=new ArrayList<String>();
                try(var input=zip.getInputStream(entry)){
                    new ClassReader(input).accept(new ClassVisitor(Opcodes.ASM9){
                        public void visit(int version,int access,String name,String signature,String parent,String[] interfaces){members.add(access+":"+name+":"+signature+":"+parent+":"+Arrays.toString(interfaces));}
                        public FieldVisitor visitField(int access,String name,String descriptor,String signature,Object value){members.add("F:"+access+":"+name+":"+descriptor+":"+signature+":"+value);return null;}
                        public MethodVisitor visitMethod(int access,String name,String descriptor,String signature,String[] exceptions){
                            members.add("M:"+access+":"+name+":"+descriptor+":"+signature+":"+Arrays.toString(exceptions));
                            return new MethodVisitor(Opcodes.ASM9){public void visitCode(){if(headers)throw new AssertionError("Executable code in conversion metadata");}};
                        }
                    },0);
                }
                result.put(entry.getName(),members);
            }
        }
        return result;
    }
    public static void main(String[] args)throws Exception {
        if(!declarations(args[0],false).equals(declarations(args[1],true)))throw new AssertionError("Conversion declarations differ from executable archive");
    }
}
