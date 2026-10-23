// MacLauncher storage bridge v1, for krkrsdl2 124bdf841f09e7ce02aa99b7b55791a0f7a900ff.
// Real directory enumeration replaces fstat.dll's required dirlist operation.
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/dirlist)
{
    if(numparams < 1) return TJS_E_BADPARAMCOUNT;
    ttstr directory = TVPNormalizeStorageName(*param[0]);
    if(directory.IsEmpty()) TVPThrowExceptionMessage(TJS_W("Directory path is empty"));
    if(directory.c_str()[directory.GetLen() - 1] != TJS_W('/')) directory += TJS_W("/");
    std::set<ttstr> names;
    const tjs_char *delimiter = TJS_strchr(directory.c_str(), TVPArchiveDelimiter);
    if(delimiter) {
        ttstr archiveName(directory, (int)(delimiter - directory.c_str()));
        ttstr prefix(delimiter + 1);
        tTVPArchive::NormalizeInArchiveStorageName(prefix);
        tTVPArchive *archive = TVPArchiveCache.Get(archiveName);
        try {
            tjs_int index = archive->GetFirstIndexStartsWith(prefix);
            for(; index >= 0 && index < (tjs_int)archive->GetCount(); index++) {
                ttstr name = archive->GetName(index);
                if(!name.StartsWith(prefix)) break;
                ttstr child(name.c_str() + prefix.GetLen());
                const tjs_char *slash = TJS_strchr(child.c_str(), TJS_W('/'));
                if(slash) child = ttstr(child, (int)(slash - child.c_str()) + 1);
                if(!child.IsEmpty()) names.insert(child);
                if(names.size() > 65536) TVPThrowExceptionMessage(TJS_W("Directory listing exceeds its bounds"));
            }
        } catch(...) { archive->Release(); throw; }
        archive->Release();
    } else {
        tjs_string local = TVPGetLocallyAccessibleName(directory).AsStdString();
        std::string native;
        if(!TVPUtf16ToUtf8(native, local) || native.empty()) TVPThrowExceptionMessage(TJS_W("Directory is not locally accessible"));
        if(native.back() != '/') native += '/';
        DIR *handle = opendir(native.c_str());
        if(!handle) TVPThrowExceptionMessage(TJS_W("Directory cannot be opened"));
        try {
            struct dirent *entry;
            while((entry = readdir(handle)) != nullptr) {
                if(!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
                tjs_string unicode;
                if(!TVPUtf8ToUtf16(unicode, std::string(entry->d_name))) TVPThrowExceptionMessage(TJS_W("Directory entry has invalid UTF-8"));
                ttstr name(unicode.c_str());
                struct stat info;
                const std::string full = native + entry->d_name;
                if(lstat(full.c_str(), &info) != 0) TVPThrowExceptionMessage(TJS_W("Directory entry cannot be inspected"));
                if(S_ISDIR(info.st_mode)) name += TJS_W("/");
                names.insert(name);
                if(names.size() > 65536) TVPThrowExceptionMessage(TJS_W("Directory listing exceeds its bounds"));
            }
        } catch(...) { closedir(handle); throw; }
        closedir(handle);
    }
    if(result) {
        iTJSDispatch2 *array = TJSCreateArrayObject();
        *result = tTJSVariant(array, array);
        array->Release();
        tjs_int index = 0;
        for(const auto &name : names) {
            tTJSVariant value(name);
            array->PropSetByNum(TJS_MEMBERENSURE, index++, &value, array);
        }
    }
    return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(/*func. name*/dirlist)
