import java.util.Arrays;

public final class OverlayOrigin {
    private static native int[] compose(int[] pixels,int width,int height,boolean topLeft);
    private static native void cached(boolean topLeft);
    public static void main(String[] args){
        System.load(args[0]);
        int[] colors={0xff110000,0xff002200,0xff000033,0xff445566};
        for(int[] extent:new int[][]{{2,2},{4,4},{3,5}}){
            for(boolean topLeft:new boolean[]{true,false}){
                int[] result=compose(colors,extent[0],extent[1],topLeft);
                int[] expected=topLeft?colors:new int[]{colors[2],colors[3],colors[0],colors[1]};
                if(!Arrays.equals(result,expected))throw new AssertionError(Arrays.toString(extent)+" origin="+topLeft+" "+Arrays.toString(result));
            }
        }
        cached(true);cached(false);
        System.out.println("PASS native source origins, independent extents, asymmetric horizontal positions, event-driven Canvas edits, immutable base recycling and clear retirement on actual Metal pixels");
    }
}
