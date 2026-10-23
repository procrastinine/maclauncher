import android.graphics.*;
import android.graphics.fonts.SystemFonts;
import android.text.*;
import java.nio.file.Path;
import java.util.*;
import maclauncher.android.fixture.RuntimeFixture;

/** Original font configuration, variable fonts, fallback shaping and native hyphenation. */
public final class SystemFontsProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        RuntimeFixture.initialize(args[0],args[1]);
        Path fonts=Path.of(args[0]).toRealPath().resolve("android-root/system/fonts");
        var config=SystemFonts.getSystemPreinstalledFontConfig();
        var map=Typeface.getSystemFontMap();
        check(!config.getNamedFamilyLists().isEmpty(),"Original configuration contains no named families");
        for(var named:config.getNamedFamilyLists())check(map.containsKey(named.getName()),"Missing configured family "+named.getName());
        for(var alias:config.getAliases())check(map.containsKey(alias.getName()),"Missing original alias "+alias.getName());
        check(map.size()>20,"Only a partial family map was installed: "+map.size());
        var available=SystemFonts.getAvailableFonts();
        check(available.size()>150,"Original native font catalog is incomplete: "+available.size());
        for(var font:available){var file=font.getFile();check(file!=null&&file.toPath().toRealPath().startsWith(fonts),"System font escaped its installed component: "+file);}
        var variable=new android.graphics.fonts.Font.Builder(fonts.resolve("Roboto-Regular.ttf").toFile()).setFontVariationSettings("'wght' 543, 'wdth' 88, 'ital' 1").build();
        Set<String> axes=new HashSet<>();for(var axis:variable.getAxes())axes.add(axis.getTag());
        check(axes.containsAll(List.of("wght","wdth","ital")),"Original Roboto variable axes are unavailable");
        TextPaint paint=new TextPaint(Paint.ANTI_ALIAS_FLAG);paint.setTypeface(Typeface.DEFAULT);paint.setTextSize(32);paint.setTextLocale(Locale.US);paint.setColor(Color.BLACK);
        for(String text:List.of("A","م","漢","अ","😀"))check(paint.hasGlyph(text),"Missing original fallback glyph: "+text);
        Bitmap pixels=Bitmap.createBitmap(512,96,Bitmap.Config.ARGB_8888);pixels.eraseColor(Color.WHITE);
        Canvas canvas=new Canvas(pixels);canvas.drawText("Android العربية 漢字 हिन्दी 😀",0,48,paint);
        int[] rendered=new int[512*96];pixels.getPixels(rendered,0,512,0,0,512,96);
        check(Arrays.stream(rendered).anyMatch(color->color!=Color.WHITE),"Original font renderer produced no pixels");
        canvas.setBitmap(null);pixels.recycle();
        String word="characteristically";
        StaticLayout layout=StaticLayout.Builder.obtain(word,0,word.length(),paint,100).setBreakStrategy(Layout.BREAK_STRATEGY_HIGH_QUALITY).setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_FULL).build();
        boolean hyphenated=false;for(int line=0;line<layout.getLineCount();line++)hyphenated|=layout.getEndHyphenEdit(line)!=0;
        check(hyphenated,"Original native hyphenation patterns were not loaded");
        System.out.println("PASS original font families="+map.size()+", native fonts="+available.size()+", variable axes, multilingual rasterization and native hyphenation");
    }
}
