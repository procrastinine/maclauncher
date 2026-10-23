import android.text.TextPaint;
import android.text.style.*;
import android.graphics.*;
public class StartupContractsProbe {
    private static void check(boolean value){if(!value)throw new AssertionError();}
    public static void main(String[] args)throws Exception{
        var loop=maclauncher.android.fixture.RuntimeFixture.initialize(args[0],args[1]);
        var description=new StringBuilder("Span content");
        try{
        var paint=new TextPaint();var floating=paint.getFontMetrics();var metrics=paint.getFontMetricsInt();
        check(metrics.top<=floating.top&&metrics.bottom>=floating.bottom&&metrics.ascent<0&&metrics.descent>=0);
        check(paint.getFontMetricsInt(null)==metrics.descent-metrics.ascent+metrics.leading);
        int[] calls={0};var span=new ReplacementSpan(){
            public int getSize(Paint p,CharSequence text,int start,int end,Paint.FontMetricsInt fm){calls[0]++;if(fm!=null)p.getFontMetricsInt(fm);return end-start;}
            public void draw(Canvas c,CharSequence text,int start,int end,float x,int top,int y,int bottom,Paint p){calls[0]++;}
        };
        span.setContentDescription(description);check(span.getContentDescription()==description);
        float size=paint.getTextSize();int color=paint.getColor();span.updateDrawState(paint);span.updateMeasureState(paint);
        check(size==paint.getTextSize()&&color==paint.getColor());
        check(span.getSize(paint,"hello",1,4,metrics)==3);span.draw(null,"hello",0,5,0,0,0,1,paint);check(calls[0]==2);
        MetricAffectingSpan metric=new MetricAffectingSpan(){
            public void updateDrawState(TextPaint p){p.setColor(0xff123456);}
            public void updateMeasureState(TextPaint p){p.setTextSize(24);}
        };
        var wrapped=CharacterStyle.wrap(CharacterStyle.wrap(metric));check(wrapped!=metric&&wrapped.getUnderlying()==metric&&wrapped instanceof UpdateLayout);
        wrapped.updateDrawState(paint);((MetricAffectingSpan)wrapped).updateMeasureState(paint);check(paint.getColor()==0xff123456&&paint.getTextSize()==24);
        }finally{maclauncher.android.framework.HostLooper.close(loop);}
        System.out.println("PASS original font metrics and span delegation");
    }
}
