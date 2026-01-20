//=============================================================================
// CustomizeMaxSaveFile.js
// ----------------------------------------------------------------------------
// Copyright (c) 2015 Triacontane
// This software is released under the MIT License.
// http://opensource.org/licenses/mit-license.php
// ----------------------------------------------------------------------------
// Version
// 1.1.1 2017/02/25 \u30bb\u30fc\u30d6\u30d5\u30a1\u30a4\u30eb\u6570\u306b\u3088\u308a\u5927\u304d\u306a\u5024\u3092\u8a2d\u5b9a\u3067\u304d\u308b\u3088\u3046\u4e0a\u9650\u3092\u958b\u653e
// 1.1.0 2016/11/03 \u30aa\u30fc\u30c8\u30bb\u30fc\u30d6\u306a\u3069\u6700\u5927\u6570\u4ee5\u4e0a\u306eID\u306b\u5bfe\u3057\u3066\u30bb\u30fc\u30d6\u3059\u308b\u30d7\u30e9\u30b0\u30a4\u30f3\u3068\u306e\u7af6\u5408\u306b\u5bfe\u5fdc
// 1.0.0 2016/03/19 \u521d\u7248
// ----------------------------------------------------------------------------
// [Blog]   : http://triacontane.blogspot.jp/
// [Twitter]: https://twitter.com/triacontane/
// [GitHub] : https://github.com/triacontane/
//=============================================================================

/*:
 * @plugindesc Customize max save file number
 * @author triacontane
 *
 * @param SaveFileNumber
 * @desc max save file number(1...100)
 * @default 20
 *
 * @help Customize max save file number
 *
 * No plugin command
 *
 * This plugin is released under the MIT License.
 */
/*:ja
 * @plugindesc \u6700\u5927\u30bb\u30fc\u30d6\u30d5\u30a1\u30a4\u30eb\u6570\u5909\u66f4\u30d7\u30e9\u30b0\u30a4\u30f3
 * @author \u30c8\u30ea\u30a2\u30b3\u30f3\u30bf\u30f3
 *
 * @param \u30bb\u30fc\u30d6\u30d5\u30a1\u30a4\u30eb\u6570
 * @desc \u6700\u5927\u30bb\u30fc\u30d6\u30d5\u30a1\u30a4\u30eb\u6570\u3067\u3059\u3002
 * @default 20
 *
 * @help \u6700\u5927\u30bb\u30fc\u30d6\u30d5\u30a1\u30a4\u30eb\u6570\u3092\u30d1\u30e9\u30e1\u30fc\u30bf\u3067\u6307\u5b9a\u3057\u305f\u5024\u306b\u5909\u66f4\u3057\u307e\u3059\u3002
 *
 * \u3053\u306e\u30d7\u30e9\u30b0\u30a4\u30f3\u306b\u306f\u30d7\u30e9\u30b0\u30a4\u30f3\u30b3\u30de\u30f3\u30c9\u306f\u3042\u308a\u307e\u305b\u3093\u3002
 *
 * \u5229\u7528\u898f\u7d04\uff1a
 *  \u4f5c\u8005\u306b\u7121\u65ad\u3067\u6539\u5909\u3001\u518d\u914d\u5e03\u304c\u53ef\u80fd\u3067\u3001\u5229\u7528\u5f62\u614b\uff08\u5546\u7528\u300118\u7981\u5229\u7528\u7b49\uff09
 *  \u306b\u3064\u3044\u3066\u3082\u5236\u9650\u306f\u3042\u308a\u307e\u305b\u3093\u3002
 *  \u3053\u306e\u30d7\u30e9\u30b0\u30a4\u30f3\u306f\u3082\u3046\u3042\u306a\u305f\u306e\u3082\u306e\u3067\u3059\u3002
 */

(function () {
    'use strict';
    var pluginName = 'CustomizeMaxSaveFile';

    var getParamNumber = function(paramNames, min, max) {
        var value = getParamOther(paramNames);
        if (arguments.length < 2) min = -Infinity;
        if (arguments.length < 3) max = Infinity;
        return (parseInt(value, 10) || 0).clamp(min, max);
    };

    var getParamOther = function(paramNames) {
        if (!Array.isArray(paramNames)) paramNames = [paramNames];
        for (var i = 0; i < paramNames.length; i++) {
            var name = PluginManager.parameters(pluginName)[paramNames[i]];
            if (name) return name;
        }
        return null;
    };
    var paramSaveFileNumber = getParamNumber(['SaveFileNumber', '\u30bb\u30fc\u30d6\u30d5\u30a1\u30a4\u30eb\u6570'], 0);

    //=============================================================================
    // DataManager
    //  \u30bb\u30fc\u30d6\u30d5\u30a1\u30a4\u30eb\u306e\u6570\u3092\u30ab\u30b9\u30bf\u30de\u30a4\u30ba\u3057\u307e\u3059\u3002
    //=============================================================================
    var _DataManager_loadGlobalInfo = DataManager.loadGlobalInfo;
    DataManager.loadGlobalInfo = function() {
        if (!this._globalInfo) {
            this._globalInfo = _DataManager_loadGlobalInfo.apply(this, arguments);
        }
        return this._globalInfo;
    };

    var _DataManager_saveGlobalInfo = DataManager.saveGlobalInfo;
    DataManager.saveGlobalInfo = function(info) {
        _DataManager_saveGlobalInfo.apply(this, arguments);
        this._globalInfo = null;
    };

    var _DataManager_maxSavefiles = DataManager.maxSavefiles;
    DataManager.maxSavefiles = function() {
        return paramSaveFileNumber ? paramSaveFileNumber : _DataManager_maxSavefiles.apply(this, arguments);
    };

    var _DataManager_isThisGameFile = DataManager.isThisGameFile;
    DataManager.isThisGameFile = function(savefileId) {
        if (savefileId > this.maxSavefiles()) {
            return false;
        } else {
            return _DataManager_isThisGameFile.apply(this, arguments);
        }
    };
})();

