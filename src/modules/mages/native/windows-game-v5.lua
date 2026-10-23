-- Windows MPK2/SC3 profile. Data is opened read-only from its original location.
root.LayerCount = 100;
root.GameFeatures = GameFeature.Sc3VirtualMachine | GameFeature.Renderer2D | GameFeature.Input | GameFeature.Audio | GameFeature.Video;
root.DesignWidth = 1920;
root.DesignHeight = 1080;
root.WindowName = "STEINS;GATE — Windows native adapter";
root.CharaIsMvl = false;
root.LayFileBigEndian = false;
root.LayFileTexXMultiplier = 1;
root.LayFileTexYMultiplier = 1;
root.VoiceTableLittleEndian = true;
root.Vm = {
    StartScript = 2, StartScriptBuffer = 0,
    GameInstructionSet = InstructionSet.SGPS3,
    UseReturnIds = true, AutoDetectReturnIds = true,
    TipsDataHasSecondaryLabel = true, WindowsOpcodeExtensions = true,
    ScrWorkChaStructSize = 20, ScrWorkChaOffsetStructSize = 10,
    ScrWorkBgStructSize = 20, ScrWorkBgOffsetStructSize = 10,
};
include(root.BasePaths.RootProfilesDir .. '/common/scriptinput.lua');
include(root.BasePaths.RootProfilesDir .. '/common/scriptvars.lua');
root.ScriptVars.SW_TITLEMODE = 2115;
root.ScriptVars.SW_TITLEMOVIECT = 2116;
root.ScriptVars.SW_TITLEDISPCT = 2119;
root.ScriptVars.SW_TITLECUR1 = 2139;
root.ScriptVars.SW_TITLECUR2 = 2140;
root.SaveData = { Type = SaveDataType.None, SaveFilePath = root.BasePaths.RootSavesDir .. '/SYSTEM.DAT' };
root.TipsSystem = { Type = TipsSystemType.CCLCC, MaxTipsCount = 512 };
root.TipsMenu = { Type = TipsMenuType.None };
root.TipsNotification = { Type = TipsNotificationType.None };
root.BacklogMenu = { Type = BacklogMenuType.None };
root.Vfs = { Mounts = {} };
for _, mount in ipairs({'script','system','bgm','se','voice','bg','chara','mask'}) do
    root.Vfs.Mounts[mount] = {root.BasePaths.RootGamedataDir .. '/' .. mount .. '.mpk'};
end
root.Vfs.Mounts.movie = {root.BasePaths.RootGamedataDir .. '/movie/1920x1080'};
root.Vfs.FileAliases = { movie = {[37] = 'title.bk2'} };
root.SpriteSheets = {
    Data = { Path = {Mount = 'system', Id = 6}, DesignWidth = 3072, DesignHeight = 1788 },
    Font = { Path = {Mount = 'system', Id = 9}, DesignWidth = 3072, DesignHeight = 2208 },
    Backlog = { Path = {Mount = 'system', Id = 2}, DesignWidth = 2048, DesignHeight = 1080 },
    Title = { Path = {Mount = 'system', Id = 30}, DesignWidth = 3072, DesignHeight = 1536 },
};
root.Sprites = {};
include(root.BasePaths.RootProfilesDir .. '/common/animation.lua');
include(root.BasePaths.RootProfilesDir .. '/sgps3/charset.lua');
include(root.BasePaths.RootProfilesDir .. '/sgps3/font.lua');
root.Fonts.Default.GridSize = { X = 64, Y = 46 };
for i = #root.Fonts.Default.AdvanceWidthsTable + 1, 64 * 46 do
    root.Fonts.Default.AdvanceWidthsTable[i] = 32;
end
include(root.BasePaths.RootProfilesDir .. '/sgps3/dialogue.lua');
include(root.BasePaths.RootProfilesDir .. '/sgps3/hud/saveicon.lua');
include(root.BasePaths.RootProfilesDir .. '/sgps3/hud/loadingdisplay.lua');
include(root.BasePaths.RootProfilesDir .. '/sgps3/hud/datedisplay.lua');
include(root.BasePaths.RootProfilesDir .. '/sgps3/hud/selectiondisplay.lua');
include(root.BasePaths.RootProfilesDir .. '/sgps3/hud/sysmesboxdisplay.lua');
root.SysMesBoxDisplay.TextX = 960;
root.SysMesBoxDisplay.TextMiddleY = 480;
root.SysMesBoxDisplay.BoxY = 390;
root.SysMesBoxDisplay.ChoiceXBase = 1000;
root.SysMesBoxDisplay.ChoiceY = 610;
root.SysMesBoxDisplay.LoadingStar = 'WindowsMessageLoadingStar';
root.SysMesBoxDisplay.LoadingStarsFadeDuration = 0.2;
root.SysMesBoxDisplay.LoadingStarsPosition = {X = 1790, Y = 660};
root.Sprites.WindowsMessageLoadingStar = {Sheet = 'Data', Bounds = {X = 0, Y = 144, Width = 48, Height = 48}};
root.Sprites.SysMesBoxBox.Bounds = {X = 1152, Y = 1200, Width = 1920, Height = 336};
root.Sprites.SysMesBoxBoxDecoration.Bounds = {X = 1152, Y = 1200, Width = 1920, Height = 1};
root.Sprites.WindowsTitleBackground = { Sheet = 'Title', Bounds = {X = 0, Y = 0, Width = 1920, Height = 1080} };
root.Sprites.WindowsTitlePrompt = { Sheet = 'Title', Bounds = {X = 190, Y = 1080, Width = 242, Height = 48} };
root.TitleMenu = {
    Type = TitleMenuType.ScriptSprites, MenuEntriesNum = 5,
    CompositeVideo = true,
    BackgroundSprite = 'WindowsTitleBackground', BackgroundPos = {X = 0, Y = 0},
    PressToStartSprite = 'WindowsTitlePrompt', PressToStartPos = {X = 840, Y = 690},
    PressToStartAnimDurationIn = 0.7, PressToStartAnimDurationOut = 0.7,
    MenuEntriesSprites = {}, MenuEntriesHighlightedSprites = {}, MenuEntryPositions = {},
    MenuEntryIds = {0, 10, 20, 30, 40},
};
for i = 0, 4 do
    local normal = 'WindowsTitleEntry' .. i;
    local highlighted = normal .. 'Highlighted';
    local y = i < 4 and i * 50 or 0;
    root.Sprites[normal] = {Sheet = 'Title', Bounds = {X = i < 4 and 1936 or 2356, Y = y, Width = 188, Height = 48}};
    root.Sprites[highlighted] = {Sheet = 'Title', Bounds = {X = i < 4 and 2136 or 2556, Y = y, Width = 188, Height = 48}};
    root.TitleMenu.MenuEntriesSprites[i + 1] = normal;
    root.TitleMenu.MenuEntriesHighlightedSprites[i + 1] = highlighted;
    root.TitleMenu.MenuEntryPositions[i + 1] = {X = 1430, Y = 390 + i * 62};
end

include(root.BasePaths.RootPatchesDir .. '/windows-ui-input.lua');
