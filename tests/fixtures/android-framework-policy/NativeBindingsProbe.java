import java.io.*;
import java.util.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

/** Native ownership/signature changes must never consume an unmatched API. */
public final class NativeBindingsProbe {
    private static final class Element {}
    public static final class Framework {
        public static native int available(int value);
        public static native int available(String value);
        public native int instance(int value);
        public native int opaque(String value);
        public static native int wrongReturn(int value);
        public static native int wrongStatic(int value);
        public static native int inaccessible(int value);
        public static native int absent(int value);
        public static native int arrayElements(Element[] values);
        public static native int arrayElements(int[] values);
        public static int javaAlgorithm(int value){return value+7;}
    }
    public static final class Backend {
        public static int available(int value){return value+1;}
        public static int instance(Framework receiver,int value){return value+2;}
        public static int opaque(Object receiver,String value){return value.length();}
        public static long wrongReturn(int value){return value;}
        public int wrongStatic(int value){return value;}
        private static int inaccessible(int value){return value;}
        public static int javaAlgorithm(int value){throw new AssertionError("Original Java was bypassed");}
        public static int arrayElements(Object[] values){return values.length;}
    }
    static ClassNode read(byte[] bytes){ClassNode result=new ClassNode();new ClassReader(bytes).accept(result,0);return result;}
    static byte[] resource(Class<?> type)throws IOException{try(var input=type.getResourceAsStream("/"+type.getName().replace('.','/')+".class")){return input.readAllBytes();}}
    static byte[] code(MethodNode method){ClassWriter writer=new ClassWriter(0);writer.visit(Opcodes.V21,Opcodes.ACC_PUBLIC,"Recorded",null,"java/lang/Object",null);method.accept(writer);writer.visitEnd();return writer.toByteArray();}
    public static void main(String[] args)throws Exception {
        byte[] original=resource(Framework.class);
        ClassNode before=read(original),after=read(NativeBindings.transform(original,Backend.class.getName().replace('.','/')));
        if(before.methods.size()!=after.methods.size()||before.fields.size()!=after.fields.size())throw new AssertionError("Upstream members changed");
        int bound=0,untouched=0;
        for(int i=0;i<before.methods.size();i++){
            MethodNode from=before.methods.get(i),to=after.methods.get(i);
            if(!from.name.equals(to.name)||!from.desc.equals(to.desc))throw new AssertionError("Upstream signature changed");
            if((from.access&Opcodes.ACC_NATIVE)!=0&&(to.access&Opcodes.ACC_NATIVE)==0){
                boolean instance=from.name.equals("instance"),opaque=from.name.equals("opaque"),array=from.name.equals("arrayElements")&&from.desc.equals("([L"+Element.class.getName().replace('.','/')+";)I");
                if(!instance&&!opaque&&!array&&!(from.name.equals("available")&&from.desc.equals("(I)I")))throw new AssertionError("Unimplemented native method was intercepted");
                List<MethodInsnNode> calls=new ArrayList<>();for(AbstractInsnNode node:to.instructions)if(node instanceof MethodInsnNode call)calls.add(call);
                String expected=instance?"(L"+before.name+";I)I":opaque?"(Ljava/lang/Object;Ljava/lang/String;)I":array?"([Ljava/lang/Object;)I":"(I)I";
                if(calls.size()!=1||!calls.get(0).desc.equals(expected)||calls.get(0).getOpcode()!=Opcodes.INVOKESTATIC)throw new AssertionError("Wrong native receiver or signature");
                bound++;
            }else{
                if(!Arrays.equals(code(from),code(to)))throw new AssertionError("Unmatched native or original Java changed: "+from.name+from.desc);
                untouched++;
            }
        }
        if(bound!=4||untouched!=8)throw new AssertionError("Unexpected coverage "+bound+"/"+untouched);
        System.out.println("PASS exact native bindings; unmatched overloads, returns, access, staticness and Java bodies preserved");
    }
}
