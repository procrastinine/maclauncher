import android.opengl.GLES20;
import java.nio.*;
public final class GlesBatchProbe {
    private static native int[] state();private static native float[] floats();private static native void pixelMode(int mode);
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static void fails(Runnable value){try{value.run();throw new AssertionError("Invalid range accepted");}catch(IllegalArgumentException|NullPointerException expected){}}
    private static ByteBuffer bytes(int n){return ByteBuffer.allocateDirect(n).order(ByteOrder.nativeOrder());}
    private static IntBuffer ints(int n){return bytes(n*4).asIntBuffer();}private static FloatBuffer floats(int n){return bytes(n*4).asFloatBuffer();}
    public static void main(String[] args){
        GLES20.glBlendColor(.25f,.5f,.75f,1);check(floats()[0]==.25f&&floats()[1]==1&&state()[3]==50&&state()[4]==75,"Scalar float ABI");check(GLES20.glIsTexture(123)&&!GLES20.glIsTexture(124),"Boolean return ABI");
        float[] fa={-1,2,3,4,5,6,7,8,9,-2};GLES20.glUniform1fv(4,3,fa,2);check(floats()[0]==3&&floats()[1]==5,"Uniform array offset/count");fails(()->GLES20.glUniform1fv(0,9,fa,2));
        var fv=floats(7);fv.put(new float[]{-1,2,3,4,5,6,-2}).position(1).limit(5);GLES20.glUniform2fv(6,2,fv.asReadOnlyBuffer());check(floats()[0]==2&&floats()[1]==5&&fv.position()==1,"Uniform vector direct offsets");fails(()->GLES20.glUniform2fv(0,3,fv));
        var iv=ints(8);iv.put(new int[]{-1,1,2,3,4,5,6,-2}).position(1).limit(7);GLES20.glUniform3iv(8,2,iv);check(state()[3]==1&&state()[4]==6,"Integer vector size");
        GLES20.glUniformMatrix2fv(9,2,false,fa,1);check(floats()[0]==2&&floats()[1]==9&&state()[5]==0,"Matrix array shape");var matrix=floats(11);for(int i=0;i<11;i++)matrix.put(i,i);matrix.position(1).limit(10);GLES20.glUniformMatrix3fv(10,1,false,matrix);check(floats()[0]==1&&floats()[1]==9,"Matrix buffer shape");fails(()->GLES20.glUniformMatrix3fv(0,Integer.MAX_VALUE,false,matrix));
        var objects=ints(5);objects.put(0,-1).put(4,-2).position(1).limit(4);GLES20.glGenFramebuffers(3,objects);check(objects.get(1)==100&&objects.get(3)==102&&objects.get(0)==-1&&objects.position()==1,"Object output range");fails(()->GLES20.glGenFramebuffers(1,objects.asReadOnlyBuffer()));
        int[] objectsArray={-1,0,0,-2};GLES20.glGenFramebuffers(2,objectsArray,1);check(objectsArray[0]==-1&&objectsArray[1]==100&&objectsArray[2]==101&&objectsArray[3]==-2,"Array output offset");GLES20.glDeleteRenderbuffers(2,objectsArray,1);check(state()[3]==100&&state()[4]==101,"Array input range");
        var four=floats(6);four.position(1).limit(5);GLES20.glGetVertexAttribfv(3,0x8626,four);check(four.get(1)==10&&four.get(4)==13,"Vector query output cardinality");fails(()->GLES20.glGetVertexAttribfv(3,0x8626,floats(3)));
        var uniform=floats(17);uniform.position(1);GLES20.glGetUniformfv(99,5,uniform);check(uniform.get(1)==20&&uniform.get(16)==35,"Actual uniform matrix cardinality");int reads=state()[6];fails(()->GLES20.glGetUniformfv(99,5,floats(15)));check(state()[6]==reads,"Uniform range checked before write");GLES20.glGetUniformfv(99,11,floats(3));check(state()[2]==3,"Array uniform location returns one element");
        var bools=ints(4);GLES20.glGetBooleanv(0x0C23,bools);check(bools.get(0)==0&&bools.get(1)==1&&bools.get(2)==0&&bools.get(3)==1,"Boolean vector IntBuffer representation");
        var amount=ints(1);var shaders=ints(3);shaders.position(1);GLES20.glGetAttachedShaders(9,2,amount,shaders);check(amount.get(0)==2&&shaders.get(1)==501&&shaders.get(2)==502,"Two independent output buffers");
        var range=ints(2);var precision=ints(1);GLES20.glGetShaderPrecisionFormat(0,0,range,precision);check(range.get(0)==-127&&range.get(1)==127&&precision.get(0)==23,"Precision query sizes");
        pixelMode(1);var image=bytes(57);image.put(2,(byte)1).put(55,(byte)2).position(3).limit(55);GLES20.glReadPixels(0,0,2,2,0x1908,0x1401,image);check(state()[2]==52&&image.get(3)==0x4D&&image.get(54)==0x4D&&image.get(2)==1,"Pack row length/skip/position bounds");fails(()->GLES20.glReadPixels(0,0,2,2,0x1908,0x1401,bytes(51)));fails(()->GLES20.glReadPixels(0,0,2,2,0x1908,0x1401,image.asReadOnlyBuffer()));
        pixelMode(0);GLES20.glReadPixels(0,0,3,2,0x1907,0x1401,bytes(21));check(state()[2]==21,"Last row excludes unused padding");fails(()->GLES20.glReadPixels(0,0,Integer.MAX_VALUE,Integer.MAX_VALUE,0x1908,0x1401,bytes(16)));
        var shaderIds=ints(3);shaderIds.put(new int[]{-1,31,32}).position(1);var binary=bytes(5);binary.put(2,(byte)72).position(2);GLES20.glShaderBinary(2,shaderIds,7,binary,3);check(state()[3]==31&&state()[4]==72&&state()[5]==7,"Shader binary typed buffers");
        fails(()->GLES20.glUniform1fv(0,1,FloatBuffer.wrap(new float[]{1})));
        System.out.println("PASS GLES20 batch families: scalar ABI, array/direct uniforms/matrices, object IDs, output cardinality, actual uniform introspection, precision, boolean vectors, pixel pack spans and shader binaries; no GPU");
    }
}
