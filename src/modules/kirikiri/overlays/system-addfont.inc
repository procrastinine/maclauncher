// MacLauncher font bridge v1. Fonts are process-local, read from real storage;
// this installs no system fonts and reports actual FreeType face discovery.
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/addFont)
{
    if(numparams < 1) return TJS_E_BADPARAMCOUNT;
    ttstr storage = *param[0];
    std::vector<ttstr> faces;
    TVPFontSystem->AddExtraFont(storage.AsStdString(), &faces);
    if(result) *result = (tjs_int)!faces.empty();
    return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(/*func. name*/addFont)

// AdjustMoni's rectangle operation uses real SDL monitor work areas. The
// nearest display to the proposed dialog centre also supports multiple screens.
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/adjustMonitor)
{
    if(numparams < 1 || param[0]->Type() != tvtObject) return TJS_E_BADPARAMCOUNT;
    iTJSDispatch2 *spec = param[0]->AsObjectNoAddRef();
    tTJSVariant left, top, width, height;
    if(TJS_FAILED(spec->PropGet(0, TJS_W("left2"), NULL, &left, spec)) ||
       TJS_FAILED(spec->PropGet(0, TJS_W("top2"), NULL, &top, spec)) ||
       TJS_FAILED(spec->PropGet(0, TJS_W("width2"), NULL, &width, spec)) ||
       TJS_FAILED(spec->PropGet(0, TJS_W("height2"), NULL, &height, spec))) return TJS_E_INVALIDPARAM;
    double x = (tjs_int64)left, y = (tjs_int64)top, w = (tjs_int64)width, h = (tjs_int64)height;
    if(w <= 0 || h <= 0 || w > INT_MAX || h > INT_MAX || x < INT_MIN || x > INT_MAX || y < INT_MIN || y > INT_MAX) return TJS_E_INVALIDPARAM;
    const double centreX = x + w / 2, centreY = y + h / 2;
    if(!(SDL_WasInit(SDL_INIT_VIDEO) & SDL_INIT_VIDEO) && SDL_InitSubSystem(SDL_INIT_VIDEO) != 0)
        TVPThrowExceptionMessage(TJS_W("Video subsystem cannot provide monitor work areas"));
    SDL_Rect best = { 0, 0, 0, 0 };
    double nearest = -1;
    const int count = SDL_GetNumVideoDisplays();
    if(count < 1 || count > 256) TVPThrowExceptionMessage(TJS_W("Monitor work areas are unavailable"));
    for(int display = 0; display < count; display++) {
        SDL_Rect area;
        if(SDL_GetDisplayUsableBounds(display, &area) != 0) continue;
        const double dx = std::max((double)area.x - centreX, std::max(0.0, centreX - (area.x + area.w)));
        const double dy = std::max((double)area.y - centreY, std::max(0.0, centreY - (area.y + area.h)));
        const double distance = dx * dx + dy * dy;
        if(nearest < 0 || distance < nearest) { nearest = distance; best = area; }
    }
    if(nearest < 0) TVPThrowExceptionMessage(TJS_W("Monitor work areas are unavailable"));
    x = std::max((double)best.x, std::min(x, best.x + best.w - w));
    y = std::max((double)best.y, std::min(y, best.y + best.h - h));
    if(result) {
        iTJSDispatch2 *dictionary = TJSCreateDictionaryObject();
        *result = tTJSVariant(dictionary, dictionary);
        dictionary->Release();
        tTJSVariant finalX((tjs_int)x), finalY((tjs_int)y);
        dictionary->PropSet(TJS_MEMBERENSURE, TJS_W("x"), NULL, &finalX, dictionary);
        dictionary->PropSet(TJS_MEMBERENSURE, TJS_W("y"), NULL, &finalY, dictionary);
    }
    return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(/*func. name*/adjustMonitor)
