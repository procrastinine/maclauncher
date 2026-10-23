import android.view.*;
import android.graphics.*;
import maclauncher.android.NativeProbeFixture;
import maclauncher.android.framework.HostDisplay;
public final class VisibleDisplayFrameProbe {
 static int checks;
 static void eq(Rect actual,Rect expected){checks++;if(!actual.equals(expected))throw new AssertionError("Rectangle mismatch: "+actual+" expected "+expected);}
 public static void main(String[] args)throws Exception {
  var fixture=NativeProbeFixture.current;var root=new android.widget.FrameLayout(fixture.context);var child=new View(fixture.context);root.addView(child);Rect out=new Rect();
  fixture.attach(root,960,600);child.getWindowVisibleDisplayFrame(out);eq(out,new Rect(0,0,960,600));
  child.layout(12,20,52,70);child.getWindowVisibleDisplayFrame(out);eq(out,new Rect(0,0,960,600));
  fixture.resize(root,800,612);child.getWindowVisibleDisplayFrame(out);eq(out,new Rect(0,0,800,612));
  out.set(3,4,5,6);root.getWindowVisibleDisplayFrame(out);eq(out,new Rect(0,0,800,612));
  var insets=new WindowInsets.Builder().setInsets(WindowInsets.Type.systemBars(),Insets.of(3,7,5,11)).setInsets(WindowInsets.Type.ime(),Insets.of(0,0,0,100)).build();
  Insets union=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.ime());if(!union.equals(Insets.of(3,7,5,100)))throw new AssertionError("Original inset union");checks++;
  // Original View reads the committed AttachInfo populated by its window server.
  var attach=View.class.getDeclaredField("mAttachInfo");attach.setAccessible(true);Object info=attach.get(root);var visible=info.getClass().getDeclaredField("mVisibleInsets");visible.setAccessible(true);Rect committed=(Rect)visible.get(info);committed.set(union.left,union.top,union.right,union.bottom);
  root.getWindowVisibleDisplayFrame(out);eq(out,new Rect(3,7,795,512));committed.setEmpty();
  fixture.detach(root);HostDisplay.hostPublish(42,400,300,60);new View(fixture.context).getWindowVisibleDisplayFrame(out);eq(out,new Rect(0,0,400,300));
  try{root.getWindowVisibleDisplayFrame(null);throw new AssertionError("Null rectangle accepted");}catch(NullPointerException expected){checks++;}
  System.out.println("PASS "+checks+" original viewport, child, resize, committed insets, detached display and caller-owned rectangle checks");
 }
}
