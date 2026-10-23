import android.graphics.Paint;
import android.graphics.Typeface;
import android.text.TextPaint;
public final class TextPaintProbe {
  static int checks;
  static void check(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
  static void same(Paint a, Paint b) {
    check(a.getTypeface()==b.getTypeface()); check(a.getTextSize()==b.getTextSize());
    check(a.getStrokeWidth()==b.getStrokeWidth()); check(a.getColor()==b.getColor());
    check(a.isAntiAlias()==b.isAntiAlias()); check(a.isFilterBitmap()==b.isFilterBitmap());
  }
  public static void main(String[] args) {
    Paint p=new Paint(0);p.setColor(0x12345678);p.setTextSize(24);p.setStrokeWidth(3);p.setFilterBitmap(false);
    Paint copy=new Paint(p);same(p,copy);copy.setColor(0xaabbccdd);check(p.getColor()==0x12345678);
    for(int i=0;i<1000;i++){p.setColor(i);p.setTextSize(1+(i%200));p.setStrokeWidth(i%50);p.setAntiAlias(i%2==0);p.setFilterBitmap(i%3==0);copy.set(p);same(p,copy);copy.set(copy);same(p,copy);}
    try {copy.set(null);throw new AssertionError();}catch(NullPointerException expected){}
    TextPaint t=new TextPaint(p);same(p,t);check(t.density==1);check(t.bgColor==0&&t.baselineShift==0&&t.linkColor==0&&t.drawableState==null&&t.underlineColor==0&&t.underlineThickness==0);
    t.bgColor=0x33445566;t.baselineShift=-5;t.linkColor=0x99887766;t.drawableState=new int[]{1,4};t.density=2.5f;t.setUnderlineText(0xff112233,7.5f);
    TextPaint tc=new TextPaint();tc.set(t);same(t,tc);check(tc.bgColor==t.bgColor&&tc.baselineShift==t.baselineShift&&tc.linkColor==t.linkColor&&tc.drawableState==t.drawableState&&tc.density==t.density&&tc.underlineColor==t.underlineColor&&tc.underlineThickness==t.underlineThickness);check(tc.getUnderlineThickness()==7.5f);
    tc.set(tc);check(tc.drawableState==t.drawableState);tc.drawableState[0]=9;check(t.drawableState[0]==9);
    TextPaint plainCopy=new TextPaint((Paint)t);same(t,plainCopy);check(plainCopy.bgColor==0&&plainCopy.drawableState==null&&plainCopy.density==1&&plainCopy.underlineColor==0);
    tc.setUnderlineText(0,99);float base=p.getUnderlineThickness();check(Float.isFinite(base)&&base>0);check(tc.getUnderlineThickness()==base);
    check(p.measureText("ABC")>0);check(t.measureText("ABC")==p.measureText("ABC"));check(t.hasGlyph("A"));
    System.out.println("PASS TextPaint state and real font contracts checks="+checks);
  }
}
