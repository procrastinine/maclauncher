import java.nio.*;

/** The producer fills these two hidden Android calls with their original
 * invokevirtual descriptors before running the production portability pass. */
public final class AndroidNioLeaseCalls {
    private static native void accessible(ByteBuffer buffer,boolean value);
    private static native boolean accessible(ByteBuffer buffer);
    private static void denied(Runnable operation){
        try{operation.run();throw new AssertionError("Revoked view remained readable");}
        catch(IllegalStateException expected){}
    }
    public static void main(String[] args){
        ByteBuffer root=ByteBuffer.allocateDirect(96).order(ByteOrder.nativeOrder());
        root.putInt(0,91);
        // The production pass must attach the scope at creation, before any
        // accessibility call. Slice's integer operands also protect ASM frames.
        ByteBuffer first=root.duplicate(),second=root.slice(0,32),readOnly=root.asReadOnlyBuffer();
        IntBuffer typed=root.asIntBuffer();
        accessible(first,false);
        if(accessible(root)||accessible(second))throw new AssertionError("Hidden accessibility state was not shared");
        denied(()->root.getInt(0));denied(()->second.get(0));denied(()->typed.get(0));denied(()->readOnly.get(0));
        accessible(second,true);
        if(root.getInt(0)!=91||typed.get(0)!=91||!accessible(first))throw new AssertionError("Original views did not reopen");
        System.out.println("PASS original Android ByteBuffer hidden calls and allocation/view bytecode retain JDK scoped access and verifier frames");
    }
}
