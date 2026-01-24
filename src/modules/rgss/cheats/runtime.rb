# MacLauncher RGSS cheats runtime (postload script).

begin
  require "json"
rescue
end

module MacLauncherCheats
  DEFAULTS = {
    "enabled" => true,
    "fieldSpeed" => 1,
    "battleSpeed" => 1,
    "moveSpeed" => 0,
    "dashSpeed" => 0,
    "alwaysDash" => false,
    "instantText" => false,
    "noEncounter" => false,
    "skipBattle" => false,
    "eventBattleOutcome" => 0,
    "expMult" => 1,
    "debugEnabled" => false,
    "audioEnabled" => false,
    "bgmVolume" => 100,
    "bgsVolume" => 100,
    "meVolume" => 100,
    "seVolume" => 100
  }

  @state = DEFAULTS.dup
  @state_version = 0
  @last_mtime = nil
  @next_check = 0.0
  @cheats_path = nil

  def self.cheats_path
    return @cheats_path if @cheats_path
    path = ENV["MACLAUNCHER_RGSS_CHEATS_FILE"] || ENV["MACLAUNCHER_CHEATS_FILE"]
    @cheats_path = path && path.strip != "" ? path : nil
    @cheats_path
  end

  def self.read_state
    path = cheats_path
    return DEFAULTS.dup unless path && File.file?(path)
    return DEFAULTS.dup unless defined?(JSON)
    begin
      raw = File.read(path)
      parsed = JSON.parse(raw)
      return DEFAULTS.merge(parsed) if parsed.is_a?(Hash)
    rescue
    end
    DEFAULTS.dup
  end

  def self.refresh!
    path = cheats_path
    if !path || !File.file?(path)
      set_state!(DEFAULTS.dup)
      @last_mtime = nil
      return
    end
    begin
      mtime = File.mtime(path).to_f
      return if @last_mtime && mtime <= @last_mtime
      @last_mtime = mtime
    rescue
      set_state!(DEFAULTS.dup)
      return
    end
    set_state!(read_state)
  end

  def self.tick
    now = Time.now.to_f
    return if now < @next_check
    @next_check = now + 0.5
    refresh!
  end

  def self.state
    @state || DEFAULTS.dup
  end

  def self.state_version
    @state_version || 0
  end

  def self.set_state!(next_state)
    next_state ||= DEFAULTS.dup
    if @state != next_state
      @state = next_state
      @state_version = (@state_version || 0) + 1
    else
      @state = next_state
    end
  end

  def self.enabled?
    state["enabled"] != false
  end

  def self.bool(key)
    state[key] == true
  end

  def self.num(key, fallback = 0)
    value = state[key]
    return fallback unless value.is_a?(Numeric)
    value
  end

  def self.in_battle?
    if defined?(SceneManager) && SceneManager.respond_to?(:scene)
      scene = SceneManager.scene
      return scene.is_a?(Scene_Battle) if defined?(Scene_Battle)
    elsif defined?($scene)
      scene = $scene
      return scene.is_a?(Scene_Battle) if defined?(Scene_Battle)
    end
    false
  end

  def self.game_speed
    speed = in_battle? ? num("battleSpeed", 1) : num("fieldSpeed", 1)
    speed = 1 if speed.nil? || speed <= 0
    speed
  end

  def self.move_speed
    num("moveSpeed", 0)
  end

  def self.dash_speed
    num("dashSpeed", 0)
  end

  def self.audio_enabled?
    bool("audioEnabled")
  end

  def self.audio_volume(key)
    volume = num(key, 100)
    volume = 0 if volume < 0
    volume = 100 if volume > 100
    volume
  end

  def self.debug_enabled?
    bool("debugEnabled")
  end

  def self.event_battle_outcome
    value = num("eventBattleOutcome", 0).to_i
    value = 0 if value < 0
    value = 4 if value > 4
    value = 4 if value == 0 && bool("skipBattle")
    value
  end

  def self.play_ok
    Sound.play_ok if defined?(Sound)
  end

  def self.play_buzzer
    Sound.play_buzzer if defined?(Sound)
  end

  def self.party_members
    return [] unless defined?($game_party)
    if $game_party.respond_to?(:all_members)
      $game_party.all_members
    elsif $game_party.respond_to?(:members)
      $game_party.members
    elsif $game_party.respond_to?(:actors)
      $game_party.actors
    else
      []
    end
  end

  def self.troop_members
    return [] unless defined?($game_troop)
    if $game_troop.respond_to?(:members)
      $game_troop.members
    elsif $game_troop.respond_to?(:alive_members)
      $game_troop.alive_members
    else
      []
    end
  end

  def self.troop_alive_members
    return [] unless defined?($game_troop)
    if $game_troop.respond_to?(:alive_members)
      $game_troop.alive_members
    else
      troop_members.select do |member|
        member && (!member.respond_to?(:alive?) || member.alive?)
      end
    end
  end

  def self.each_party_member
    party_members.each do |actor|
      next unless actor
      yield actor
    end
  end

  def self.change_level_all(level)
    each_party_member do |actor|
      if actor.respond_to?(:change_level)
        actor.change_level(level, false)
      elsif actor.respond_to?(:level=)
        actor.level = level
      end
    end
  end

  def self.add_param_all(index, delta)
    each_party_member do |actor|
      if actor.respond_to?(:add_param)
        actor.add_param(index, delta)
      elsif actor.respond_to?(:add_parameter)
        actor.add_parameter(index, delta)
      end
    end
  end

  def self.set_party_hp(value)
    each_party_member do |actor|
      actor.hp = value if actor.respond_to?(:hp=)
    end
  end

  def self.set_party_mp(value)
    each_party_member do |actor|
      if actor.respond_to?(:mp=)
        actor.mp = value
      elsif actor.respond_to?(:sp=)
        actor.sp = value
      end
    end
  end

  def self.set_party_hp_max
    each_party_member do |actor|
      if actor.respond_to?(:mhp)
        actor.hp = actor.mhp
      elsif actor.respond_to?(:maxhp)
        actor.hp = actor.maxhp
      end
    end
  end

  def self.set_party_mp_max
    each_party_member do |actor|
      if actor.respond_to?(:mmp)
        actor.mp = actor.mmp
      elsif actor.respond_to?(:maxsp)
        actor.sp = actor.maxsp
      end
    end
  end

  def self.recover_party
    each_party_member do |actor|
      actor.recover_all if actor.respond_to?(:recover_all)
    end
  end

  def self.recover_enemies
    troop_members.each do |enemy|
      enemy.recover_all if enemy && enemy.respond_to?(:recover_all)
    end
  end

  def self.set_enemy_hp(value)
    troop_alive_members.each do |enemy|
      enemy.hp = value if enemy && enemy.respond_to?(:hp=)
    end
  end

  def self.gain_gold(amount)
    return false unless defined?($game_party)
    return false unless $game_party.respond_to?(:gain_gold)
    $game_party.gain_gold(amount)
    true
  rescue
    false
  end

  def self.gain_item(item, amount)
    return false unless defined?($game_party) && item
    return false unless $game_party.respond_to?(:gain_item)
    $game_party.gain_item(item, amount)
    true
  rescue
    false
  end

  def self.item_count(item)
    return 0 unless defined?($game_party) && item
    if $game_party.respond_to?(:item_number)
      $game_party.item_number(item)
    elsif $game_party.respond_to?(:item_count)
      $game_party.item_count(item)
    else
      0
    end
  rescue
    0
  end

  def self.gain_all_items
    total = 0
    [$data_items, $data_weapons, $data_armors].each do |list|
      next unless list
      list.each do |item|
        next if item.nil?
        next if item.respond_to?(:name) && item.name.to_s == ""
        gain_item(item, 999)
        total += 1
      end
    end
    total
  end

  def self.param_definitions
    case rgss_version
    when 1
      [
        { "id" => "mhp", "label" => "Max HP", "index" => 0 },
        { "id" => "msp", "label" => "Max SP", "index" => 1 },
        { "id" => "str", "label" => "STR", "index" => 2 },
        { "id" => "dex", "label" => "DEX", "index" => 3 },
        { "id" => "agi", "label" => "AGI", "index" => 4 },
        { "id" => "int", "label" => "INT", "index" => 5 }
      ]
    when 2
      [
        { "id" => "mhp", "label" => "Max HP", "index" => 0 },
        { "id" => "mmp", "label" => "Max MP", "index" => 1 },
        { "id" => "atk", "label" => "ATK", "index" => 2 },
        { "id" => "def", "label" => "DEF", "index" => 3 },
        { "id" => "spi", "label" => "SPI", "index" => 4 },
        { "id" => "agi", "label" => "AGI", "index" => 5 }
      ]
    else
      [
        { "id" => "mhp", "label" => "Max HP", "index" => 0 },
        { "id" => "mmp", "label" => "Max MP", "index" => 1 },
        { "id" => "atk", "label" => "ATK", "index" => 2 },
        { "id" => "def", "label" => "DEF", "index" => 3 },
        { "id" => "mat", "label" => "MAT", "index" => 4 },
        { "id" => "mdf", "label" => "MDF", "index" => 5 },
        { "id" => "agi", "label" => "AGI", "index" => 6 },
        { "id" => "luk", "label" => "LUK", "index" => 7 }
      ]
    end
  end

  def self.teleport_path
    path = cheats_path
    return nil unless path
    "#{path}.rgss-teleports.json"
  end

  def self.load_teleports
    path = teleport_path
    return [] unless path && File.file?(path) && defined?(JSON)
    begin
      parsed = JSON.parse(File.read(path))
      return parsed if parsed.is_a?(Array)
    rescue
    end
    []
  end

  def self.teleports
    @teleports ||= begin
      slots = load_teleports
      slots = [] unless slots.is_a?(Array)
      slots[0, 8] + Array.new([0, 8 - slots.length].max)
    end
  end

  def self.save_teleports(slots)
    payload = slots ? slots[0, 8] : []
    @teleports = payload
    return false unless persist_supported?
    path = teleport_path
    return false unless path
    json = JSON.respond_to?(:pretty_generate) ? JSON.pretty_generate(payload) : JSON.generate(payload)
    File.open(path, "wb") { |f| f.write(json) }
    true
  rescue
    false
  end

  def self.save_teleport_slot(slot_index, map_id, x, y)
    slots = teleports
    slots[slot_index] = { "map" => map_id.to_i, "x" => x.to_i, "y" => y.to_i }
    save_teleports(slots)
  end

  def self.load_teleport_slot(slot_index)
    slots = teleports
    slot = slots[slot_index]
    return nil unless slot.is_a?(Hash)
    map_id = slot["map"] || slot[:map]
    x = slot["x"] || slot[:x]
    y = slot["y"] || slot[:y]
    return nil unless map_id && x && y
    [map_id.to_i, x.to_i, y.to_i]
  end

  def self.teleport_to(map_id, x, y)
    return false unless defined?($game_player)
    if $game_player.respond_to?(:reserve_transfer)
      $game_player.reserve_transfer(map_id, x, y, 0)
    elsif $game_player.respond_to?(:transfer)
      $game_player.transfer(map_id, x, y, 0)
    elsif defined?($game_map) && $game_map.respond_to?(:setup) && $game_player.respond_to?(:moveto)
      $game_map.setup(map_id)
      $game_player.moveto(x, y)
      $game_player.refresh if $game_player.respond_to?(:refresh)
    else
      return false
    end
    true
  rescue
    false
  end

  ASAC_KEYS = ["q", "w", "e"]

  def self.load_asac_scripts
    @asac_cache = {}
    ASAC_KEYS.each do |key|
      path = "asac.#{key}.rb"
      next unless File.file?(path)
      @asac_cache[key] = File.read(path)
    end
    @asac_cache
  end

  def self.run_asac_script(key)
    load_asac_scripts unless @asac_cache
    source = @asac_cache[key]
    return false unless source
    eval(source, TOPLEVEL_BINDING, "asac.#{key}.rb")
    true
  rescue
    false
  end

  CHEAT_FIELDS = [
    { "key" => "enabled", "label" => "Enable cheats", "type" => :toggle },
    { "key" => "fieldSpeed", "label" => "Game speed (field)", "type" => :number, "min" => 1, "max" => 10, "step" => 1 },
    { "key" => "battleSpeed", "label" => "Game speed (battle)", "type" => :number, "min" => 1, "max" => 10, "step" => 1 },
    { "key" => "moveSpeed", "label" => "Move speed override", "type" => :number, "min" => 0, "max" => 10, "step" => 1 },
    { "key" => "dashSpeed", "label" => "Dash speed override", "type" => :number, "min" => 0, "max" => 10, "step" => 1 },
    {
      "key" => "alwaysDash",
      "label" => "Always dash",
      "type" => :toggle,
      "support" => lambda { defined?(Game_Player) && Game_Player.method_defined?(:dash?) }
    },
    {
      "key" => "instantText",
      "label" => "Instant text",
      "type" => :toggle,
      "support" => lambda { defined?(Window_Message) && Window_Message.method_defined?(:clear_flags) }
    },
    {
      "key" => "noEncounter",
      "label" => "No random encounters",
      "type" => :toggle,
      "support" => lambda { defined?(Game_Player) && Game_Player.method_defined?(:update_encounter) }
    },
    {
      "key" => "skipBattle",
      "label" => "Skip event battles",
      "type" => :toggle,
      "support" => lambda {
        defined?(Game_Interpreter) &&
          (Game_Interpreter.method_defined?(:command_301) ||
            Game_Interpreter.method_defined?(:command_601) ||
            Game_Interpreter.method_defined?(:command_602) ||
            Game_Interpreter.method_defined?(:command_603))
      }
    },
    {
      "key" => "eventBattleOutcome",
      "label" => "Event battle outcome",
      "type" => :number,
      "min" => 0,
      "max" => 4,
      "step" => 1,
      "options" => {
        0 => "Normal",
        1 => "Win",
        2 => "Lose",
        3 => "Escape",
        4 => "Skip"
      },
      "support" => lambda {
        defined?(Game_Interpreter) &&
          (Game_Interpreter.method_defined?(:command_301) ||
            Game_Interpreter.method_defined?(:command_601) ||
            Game_Interpreter.method_defined?(:command_602) ||
            Game_Interpreter.method_defined?(:command_603))
      }
    },
    {
      "key" => "expMult",
      "label" => "EXP multiplier",
      "type" => :number,
      "min" => 0,
      "max" => 50,
      "step" => 0.5,
      "support" => lambda { defined?(Game_Troop) && Game_Troop.method_defined?(:exp_total) }
    },
    {
      "key" => "debugEnabled",
      "label" => "Enable debug (F9)",
      "type" => :toggle,
      "support" => lambda { defined?(Scene_Debug) }
    },
    { "key" => "audioEnabled", "label" => "Override audio volumes", "type" => :toggle },
    {
      "key" => "bgmVolume",
      "label" => "BGM volume",
      "type" => :number,
      "min" => 0,
      "max" => 100,
      "step" => 1,
      "support" => lambda { defined?(RPG::BGM) && RPG::BGM.method_defined?(:play) }
    },
    {
      "key" => "bgsVolume",
      "label" => "BGS volume",
      "type" => :number,
      "min" => 0,
      "max" => 100,
      "step" => 1,
      "support" => lambda { defined?(RPG::BGS) && RPG::BGS.method_defined?(:play) }
    },
    {
      "key" => "meVolume",
      "label" => "ME volume",
      "type" => :number,
      "min" => 0,
      "max" => 100,
      "step" => 1,
      "support" => lambda { defined?(RPG::ME) && RPG::ME.method_defined?(:play) }
    },
    {
      "key" => "seVolume",
      "label" => "SE volume",
      "type" => :number,
      "min" => 0,
      "max" => 100,
      "step" => 1,
      "support" => lambda { defined?(RPG::SE) && RPG::SE.method_defined?(:play) }
    }
  ]

  def self.cheat_fields
    CHEAT_FIELDS.select do |item|
      support = item["support"]
      support ? support.call : true
    end
  end

  def self.rgss_version
    return 1 unless defined?(SceneManager)
    begin
      return 3 if defined?(Window_Command) && Window_Command.instance_method(:initialize).arity == 2
    rescue
    end
    2
  end

  def self.line_height
    rgss_version == 1 ? 32 : 24
  end

  def self.screen_width
    return Graphics.width if defined?(Graphics) && Graphics.respond_to?(:width)
    640
  end

  def self.screen_height
    return Graphics.height if defined?(Graphics) && Graphics.respond_to?(:height)
    480
  end

  def self.menu_active?
    @menu_active == true
  end

  def self.menu_active=(value)
    @menu_active = value ? true : false
  end

  def self.keycode(name)
    return name unless defined?(Input)
    return Input.const_get(name) if Input.const_defined?(name)
    name
  end

  def self.input_trigger?(key)
    return false unless defined?(Input)
    Input.trigger?(key)
  rescue
    false
  end

  def self.input_press?(key)
    return false unless defined?(Input)
    Input.press?(key)
  rescue
    false
  end

  def self.input_repeat?(key)
    return false unless defined?(Input)
    if Input.respond_to?(:repeat?)
      Input.repeat?(key)
    else
      Input.trigger?(key)
    end
  rescue
    false
  end

  def self.pressed_any?(keys)
    keys.any? { |key| input_press?(keycode(key)) }
  end

  def self.cmd_pressed?
    pressed_any?([:CTRL, :CONTROL, :CMD, :COMMAND, :META])
  end

  def self.option_pressed?
    pressed_any?([:ALT, :OPTION])
  end

  def self.shift_pressed?
    pressed_any?([:SHIFT])
  end

  def self.hotkey_pressed?
    return true if input_trigger?(keycode(:F8))
    if input_trigger?(keycode(:T)) && shift_pressed? && cmd_pressed?
      return true
    end
    if input_trigger?(keycode(:T)) && option_pressed?
      return true
    end
    false
  end

  def self.open_menu
    return if menu_active?
    if defined?(SceneManager) && SceneManager.respond_to?(:call)
      SceneManager.call(Scene_MacLauncherCheats)
    elsif defined?($scene)
      $scene = Scene_MacLauncherCheats.new
    end
  end

  def self.check_hotkey
    return if menu_active?
    return unless hotkey_pressed?
    open_menu
  end

  def self.check_debug_hotkey
    return unless enabled? && debug_enabled?
    return unless input_press?(keycode(:F9))
    return unless defined?(Scene_Debug)
    if defined?($game_player) && $game_player.respond_to?(:moving?) && $game_player.moving?
      return
    end
    if defined?(SceneManager) && SceneManager.respond_to?(:call)
      SceneManager.call(Scene_Debug)
    elsif defined?($scene)
      $scene = Scene_Debug.new
    end
  end

  def self.persist_supported?
    path = cheats_path
    path && defined?(JSON)
  end

  def self.save_state
    return false unless persist_supported?
    path = cheats_path
    return false unless path
    begin
      json = JSON.respond_to?(:pretty_generate) ? JSON.pretty_generate(state) : JSON.generate(state)
      File.open(path, "wb") { |f| f.write(json) }
      @last_mtime = File.mtime(path).to_f rescue @last_mtime
      true
    rescue
      false
    end
  end

  def self.toggle!(key)
    next_state = state.dup
    next_state[key] = !bool(key)
    set_state!(next_state)
    save_state
    state
  end

  def self.adjust!(key, delta, item = nil)
    current = num(key, DEFAULTS[key] || 0)
    item ||= CHEAT_FIELDS.find { |entry| entry["key"] == key }
    step = item && item["step"] ? item["step"].to_f : 1.0
    min = item && item["min"] ? item["min"].to_f : nil
    max = item && item["max"] ? item["max"].to_f : nil
    next_value = current + (delta * step)
    next_value = min if !min.nil? && next_value < min
    next_value = max if !max.nil? && next_value > max
    next_value = next_value.to_i if step == 1.0 && next_value.is_a?(Numeric)
    next_state = state.dup
    next_state[key] = next_value
    set_state!(next_state)
    save_state
    state
  end
end

MacLauncherCheats.refresh!

unless defined?($maclauncher_rgss_cheats_loaded)
  $maclauncher_rgss_cheats_loaded = true

  if defined?(Graphics)
    class << Graphics
      if method_defined?(:update)
        alias maclauncher_cheats_update update
        def update
          MacLauncherCheats.tick
          speed = MacLauncherCheats.enabled? ? MacLauncherCheats.game_speed.to_i : 1
          speed = 1 if speed < 1
          if speed == 1
            maclauncher_cheats_update
          else
            if Graphics.respond_to?(:frame_count) && Graphics.frame_count % speed != 0
              Graphics.frame_count += 1
              return
            end
            maclauncher_cheats_update
          end
        end
      end

      if method_defined?(:wait)
        alias maclauncher_cheats_wait wait
        def wait(duration)
          MacLauncherCheats.tick
          speed = MacLauncherCheats.enabled? ? MacLauncherCheats.game_speed.to_f : 1.0
          speed = 1.0 if speed <= 0
          return maclauncher_cheats_wait(duration) if speed == 1.0
          maclauncher_cheats_wait((duration / speed).ceil)
        end
      end

      if method_defined?(:fadein)
        alias maclauncher_cheats_fadein fadein
        def fadein(duration)
          speed = MacLauncherCheats.enabled? ? MacLauncherCheats.game_speed.to_f : 1.0
          speed = 1.0 if speed <= 0
          return maclauncher_cheats_fadein(duration) if speed == 1.0
          maclauncher_cheats_fadein((duration / speed).ceil)
        end
      end

      if method_defined?(:fadeout)
        alias maclauncher_cheats_fadeout fadeout
        def fadeout(duration)
          speed = MacLauncherCheats.enabled? ? MacLauncherCheats.game_speed.to_f : 1.0
          speed = 1.0 if speed <= 0
          return maclauncher_cheats_fadeout(duration) if speed == 1.0
          maclauncher_cheats_fadeout((duration / speed).ceil)
        end
      end

      if method_defined?(:transition)
        alias maclauncher_cheats_transition transition
        def transition(*args)
          speed = MacLauncherCheats.enabled? ? MacLauncherCheats.game_speed.to_f : 1.0
          speed = 1.0 if speed <= 0
          return maclauncher_cheats_transition(*args) if speed == 1.0
          adjusted = args.dup
          if adjusted.length >= 1 && adjusted[0].is_a?(Numeric)
            adjusted[0] = (adjusted[0] / speed).ceil
          elsif adjusted.length >= 2 && adjusted[1].is_a?(Numeric)
            adjusted[1] = (adjusted[1] / speed).ceil
          end
          maclauncher_cheats_transition(*adjusted)
        end
      end
    end
  end

  if defined?(Game_Player) && Game_Player.method_defined?(:dash?)
    class Game_Player
      alias maclauncher_cheats_dash dash?
      def dash?
        return true if MacLauncherCheats.enabled? && MacLauncherCheats.bool("alwaysDash")
        maclauncher_cheats_dash
      end
    end
  end

  if defined?(Game_Player) && Game_Player.method_defined?(:debug_through?)
    class Game_Player
      alias maclauncher_cheats_debug_through? debug_through?
      def debug_through?
        if MacLauncherCheats.enabled? && MacLauncherCheats.debug_enabled?
          return true if MacLauncherCheats.input_press?(MacLauncherCheats.keycode(:CTRL))
        end
        maclauncher_cheats_debug_through?
      end
    end
  end

  if defined?(Game_CharacterBase) && Game_CharacterBase.method_defined?(:real_move_speed)
    class Game_CharacterBase
      alias maclauncher_cheats_real_move_speed real_move_speed
      def real_move_speed
        base = maclauncher_cheats_real_move_speed
        return base unless MacLauncherCheats.enabled?
        return base unless defined?($game_player) && self == $game_player
        dash_speed = MacLauncherCheats.dash_speed
        move_speed = MacLauncherCheats.move_speed
        if respond_to?(:dash?) && dash? && dash_speed > 0
          return dash_speed
        end
        return move_speed if move_speed > 0
        base
      end
    end
  elsif defined?(Game_Character) && Game_Character.method_defined?(:real_move_speed)
    class Game_Character
      alias maclauncher_cheats_real_move_speed real_move_speed
      def real_move_speed
        base = maclauncher_cheats_real_move_speed
        return base unless MacLauncherCheats.enabled?
        return base unless defined?($game_player) && self == $game_player
        dash_speed = MacLauncherCheats.dash_speed
        move_speed = MacLauncherCheats.move_speed
        if respond_to?(:dash?) && dash? && dash_speed > 0
          return dash_speed
        end
        return move_speed if move_speed > 0
        base
      end
    end
  end

  if defined?(Game_Player) && Game_Player.method_defined?(:update_encounter)
    class Game_Player
      alias maclauncher_cheats_update_encounter update_encounter
      def update_encounter
        if MacLauncherCheats.enabled? && MacLauncherCheats.bool("noEncounter")
          return false
        end
        maclauncher_cheats_update_encounter
      end
    end
  end

  if defined?(Game_Interpreter)
    if Game_Interpreter.method_defined?(:command_301)
      class Game_Interpreter
        alias maclauncher_cheats_command_301 command_301
        def command_301
          if MacLauncherCheats.enabled? && MacLauncherCheats.event_battle_outcome > 0
            return true
          end
          maclauncher_cheats_command_301
        end
      end
    end
    if Game_Interpreter.method_defined?(:command_601)
      class Game_Interpreter
        alias maclauncher_cheats_command_601 command_601
        def command_601
          outcome = MacLauncherCheats.enabled? ? MacLauncherCheats.event_battle_outcome : 0
          return true if outcome == 1
          if outcome > 0
            return command_skip if respond_to?(:command_skip)
            return true
          end
          maclauncher_cheats_command_601
        end
      end
    end
    if Game_Interpreter.method_defined?(:command_602)
      class Game_Interpreter
        alias maclauncher_cheats_command_602 command_602
        def command_602
          outcome = MacLauncherCheats.enabled? ? MacLauncherCheats.event_battle_outcome : 0
          return true if outcome == 3
          if outcome > 0
            return command_skip if respond_to?(:command_skip)
            return true
          end
          maclauncher_cheats_command_602
        end
      end
    end
    if Game_Interpreter.method_defined?(:command_603)
      class Game_Interpreter
        alias maclauncher_cheats_command_603 command_603
        def command_603
          outcome = MacLauncherCheats.enabled? ? MacLauncherCheats.event_battle_outcome : 0
          return true if outcome == 2
          if outcome > 0
            return command_skip if respond_to?(:command_skip)
            return true
          end
          maclauncher_cheats_command_603
        end
      end
    end
  end

  if defined?(Window_Message) && Window_Message.method_defined?(:clear_flags)
    class Window_Message
      alias maclauncher_cheats_clear_flags clear_flags
      def clear_flags
        maclauncher_cheats_clear_flags
        if MacLauncherCheats.enabled? && MacLauncherCheats.bool("instantText")
          @show_fast = true
        end
      end
    end
  end

  if defined?(Game_Troop) && Game_Troop.method_defined?(:exp_total)
    class Game_Troop
      alias maclauncher_cheats_exp_total exp_total
      def exp_total
        exp = maclauncher_cheats_exp_total
        return exp unless MacLauncherCheats.enabled?
        mult = MacLauncherCheats.num("expMult", 1)
        return exp if mult == 1
        (exp * mult).to_i
      end
    end
  end

  if defined?(RPG)
    if defined?(RPG::BGM) && RPG::BGM.method_defined?(:play)
      class RPG::BGM
        alias maclauncher_cheats_play play
        def play(*args)
          if MacLauncherCheats.enabled? && MacLauncherCheats.audio_enabled?
            orig = @volume
            @volume = MacLauncherCheats.audio_volume("bgmVolume")
            maclauncher_cheats_play(*args)
            @volume = orig
          else
            maclauncher_cheats_play(*args)
          end
        end
      end
    end
    if defined?(RPG::BGS) && RPG::BGS.method_defined?(:play)
      class RPG::BGS
        alias maclauncher_cheats_play play
        def play(*args)
          if MacLauncherCheats.enabled? && MacLauncherCheats.audio_enabled?
            orig = @volume
            @volume = MacLauncherCheats.audio_volume("bgsVolume")
            maclauncher_cheats_play(*args)
            @volume = orig
          else
            maclauncher_cheats_play(*args)
          end
        end
      end
    end
    if defined?(RPG::ME) && RPG::ME.method_defined?(:play)
      class RPG::ME
        alias maclauncher_cheats_play play
        def play(*args)
          if MacLauncherCheats.enabled? && MacLauncherCheats.audio_enabled?
            orig = @volume
            @volume = MacLauncherCheats.audio_volume("meVolume")
            maclauncher_cheats_play(*args)
            @volume = orig
          else
            maclauncher_cheats_play(*args)
          end
        end
      end
    end
    if defined?(RPG::SE) && RPG::SE.method_defined?(:play)
      class RPG::SE
        alias maclauncher_cheats_play play
        def play(*args)
          if MacLauncherCheats.enabled? && MacLauncherCheats.audio_enabled?
            orig = @volume
            @volume = MacLauncherCheats.audio_volume("seVolume")
            maclauncher_cheats_play(*args)
            @volume = orig
          else
            maclauncher_cheats_play(*args)
          end
        end
      end
    end
  end

  if defined?(DataManager) && DataManager.respond_to?(:savefile_max)
    class << DataManager
      alias maclauncher_cheats_savefile_max savefile_max
      def savefile_max
        return 99 if MacLauncherCheats.enabled?
        maclauncher_cheats_savefile_max
      end
    end
  end

  if defined?(Window_Base)
    class Window_MacLauncherCheatsHelp < Window_Base
      def initialize(x, y, width, height)
        super(x, y, width, height)
        @lines = []
        refresh
      end

      def set_lines(lines)
        @lines = lines.is_a?(Array) ? lines : [lines.to_s]
        refresh
      end

      def refresh
        prepare_contents
        lh = line_height_value
        @lines.each_with_index do |line, index|
          draw_text(0, index * lh, contents.width, lh, line, 0)
        end
      end

      def line_height_value
        if respond_to?(:line_height)
          line_height
        else
          MacLauncherCheats.line_height
        end
      end

      def prepare_contents
        if respond_to?(:create_contents)
          create_contents
        else
          if self.contents && (!self.contents.respond_to?(:disposed?) || !self.contents.disposed?)
            self.contents.dispose
          end
          self.contents = Bitmap.new(self.width - 32, self.height - 32)
        end
        self.contents.clear if self.contents
      end
    end

    class Window_MacLauncherCheatsList < Window_Base
      attr_reader :index, :top_index

      def initialize(x, y, width, height)
        super(x, y, width, height)
        @items = []
        @index = 0
        @top_index = 0
        @label_resolver = nil
        @value_resolver = nil
        refresh
      end

      def set_items(items)
        @items = items || []
        @index = 0 if @index >= item_count
        @top_index = 0 if @top_index >= item_count
        ensure_visible
        refresh
      end

      def set_index(index, top_index = nil)
        @index = index || 0
        @top_index = top_index.nil? ? @top_index : top_index
        clamp_indices
        ensure_visible
        refresh
      end

      def set_label_resolver(resolver)
        @label_resolver = resolver
        refresh
      end

      def set_value_resolver(resolver)
        @value_resolver = resolver
        refresh
      end

      def item_count
        @items ? @items.length : 0
      end

      def current_item
        return nil if item_count == 0
        @items[@index]
      end

      def move_down
        return if item_count == 0
        set_index(@index + 1, @top_index)
      end

      def move_up
        return if item_count == 0
        set_index(@index - 1, @top_index)
      end

      def clamp_indices
        @index = 0 if @index < 0
        @index = item_count - 1 if @index >= item_count && item_count > 0
        @top_index = 0 if @top_index < 0
      end

      def ensure_visible
        rows = visible_rows
        return if rows <= 0
        if @index < @top_index
          @top_index = @index
        elsif @index >= @top_index + rows
          @top_index = @index - rows + 1
        end
      end

      def visible_rows
        ensure_contents
        h = item_line_height
        return 0 if h <= 0
        (contents.height / h).floor
      end

      def item_line_height
        if respond_to?(:line_height)
          return line_height
        end
        MacLauncherCheats.line_height
      end

      def refresh
        prepare_contents
        @items.each_index { |i| draw_item(i) }
      end

      def ensure_contents
        if !self.contents || (self.contents.respond_to?(:disposed?) && self.contents.disposed?)
          prepare_contents
        end
      end

      def prepare_contents
        if respond_to?(:create_contents)
          create_contents
        else
          if self.contents && (!self.contents.respond_to?(:disposed?) || !self.contents.disposed?)
            self.contents.dispose
          end
          self.contents = Bitmap.new(self.width - 32, self.height - 32)
        end
        self.contents.clear if self.contents
      end

      def draw_item(index)
        return if index < @top_index
        return if index >= @top_index + visible_rows
        item = @items[index]
        rect = item_rect(index)
        if index == @index
          contents.fill_rect(rect.x, rect.y, rect.width, rect.height, selection_color)
        end
        draw_text(rect.x + 4, rect.y, rect.width - 8, rect.height, item_label(item), 0)
        draw_text(rect.x + 4, rect.y, rect.width - 8, rect.height, item_value(item), 2)
      end

      def item_rect(index)
        h = item_line_height
        y = (index - @top_index) * h
        Rect.new(0, y, contents.width, h)
      end

      def selection_color
        Color.new(255, 255, 255, 48)
      end

      def item_label(item)
        if @label_resolver
          label = @label_resolver.call(item)
          return label.to_s if label
        end
        item["label"] || item["key"].to_s
      end

      def item_value(item)
        if @value_resolver
          value = @value_resolver.call(item)
          return value.to_s if value
        end
        key = item["key"]
        if item["type"] == :toggle
          MacLauncherCheats.bool(key) ? "ON" : "OFF"
        elsif item["type"] == :number
          value = MacLauncherCheats.num(key, MacLauncherCheats::DEFAULTS[key] || 0)
          step = item["step"] ? item["step"].to_f : 1.0
          if item["options"] && item["options"][value.to_i]
            item["options"][value.to_i]
          elsif step < 1
            format("%.1f", value.to_f)
          else
            value.to_i.to_s
          end
        elsif item["type"] == :submenu
          ">"
        else
          ""
        end
      end
    end

    module MacLauncherCheatsSceneLogic
      def mlc_start
        MacLauncherCheats.menu_active = true
        MacLauncherCheats.refresh!
        @menu_state = {}
        @menu_stack = []
        @last_state_version = MacLauncherCheats.state_version
        @menu_state["gold_delta"] = 10000
        @menu_state["item_quantity"] = 1
        push_menu(build_main_menu, "Cheats")
        create_windows
        apply_menu_state
      end

      def mlc_update
        if MacLauncherCheats.state_version != @last_state_version
          @last_state_version = MacLauncherCheats.state_version
          if @list_window && (!@list_window.respond_to?(:disposed?) || !@list_window.disposed?)
            @list_window.refresh
          end
        end
        handle_input
      end

      def mlc_terminate
        MacLauncherCheats.menu_active = false
        @list_window.dispose if @list_window
        @help_window.dispose if @help_window
      end

      def create_windows
        width = MacLauncherCheats.screen_width
        height = MacLauncherCheats.screen_height
        help_height = MacLauncherCheats.line_height * 2 + 32
        @help_window = Window_MacLauncherCheatsHelp.new(0, 0, width, help_height)
        @list_window = Window_MacLauncherCheatsList.new(0, help_height, width, height - help_height)
        @list_window.set_label_resolver(method(:label_for_item))
        @list_window.set_value_resolver(method(:value_for_item))
      end

      def build_main_menu
        [
          { "type" => :submenu, "label" => "Cheat toggles", "submenu" => :build_cheat_toggles, "title" => "Cheat Toggles" },
          { "type" => :submenu, "label" => "Cheat values", "submenu" => :build_cheat_values, "title" => "Cheat Values" },
          { "type" => :submenu, "label" => "Actions", "submenu" => :build_actions_menu, "title" => "Actions" },
          { "type" => :submenu, "label" => "Items", "submenu" => :build_items_menu, "title" => "Items" },
          { "type" => :submenu, "label" => "Teleport", "submenu" => :build_teleport_menu, "title" => "Teleport", "mode" => :teleport },
          { "type" => :action, "label" => "Open save menu", "action" => :action_open_save, "support" => lambda { defined?(Scene_Save) } }
        ]
      end

      def build_cheat_toggles
        MacLauncherCheats.cheat_fields.select { |item| item["type"] == :toggle }.map do |item|
          item.dup.merge("store" => :cheat)
        end
      end

      def build_cheat_values
        MacLauncherCheats.cheat_fields.select { |item| item["type"] == :number }.map do |item|
          item.dup.merge("store" => :cheat)
        end
      end

      def build_actions_menu
        items = [
          { "type" => :action, "label" => "Heal party", "action" => :action_heal_party },
          { "type" => :action, "label" => "Max HP", "action" => :action_max_hp },
          { "type" => :action, "label" => "Max MP", "action" => :action_max_mp },
          { "type" => :action, "label" => "Party HP -> 1", "action" => :action_party_hp_one },
          { "type" => :action, "label" => "Party MP -> 1", "action" => :action_party_mp_one },
          { "type" => :action, "label" => "Enemy HP -> 1", "action" => :action_enemy_hp_one, "support" => lambda { defined?($game_troop) } },
          { "type" => :action, "label" => "Kill enemies", "action" => :action_enemy_kill, "support" => lambda { defined?($game_troop) } },
          { "type" => :action, "label" => "Heal enemies", "action" => :action_enemy_heal, "support" => lambda { defined?($game_troop) } },
          { "type" => :action, "label" => "God stats", "action" => :action_god_stats },
          { "type" => :action, "label" => "Gain all items", "action" => :action_gain_all_items },
          {
            "type" => :action,
            "label" => "Toggle fullscreen",
            "action" => :action_toggle_fullscreen,
            "support" => lambda { defined?(Graphics) && Graphics.respond_to?(:toggle_fullscreen) }
          },
          {
            "type" => :action,
            "label" => "Toggle screen size",
            "action" => :action_toggle_ratio,
            "support" => lambda { defined?(Graphics) && Graphics.respond_to?(:toggle_ratio) }
          },
          { "type" => :submenu, "label" => "Levels", "submenu" => :build_level_menu, "title" => "Levels" },
          { "type" => :submenu, "label" => "Stats", "submenu" => :build_stats_menu, "title" => "Stats" },
          { "type" => :submenu, "label" => "Gold", "submenu" => :build_gold_menu, "title" => "Gold" },
          { "type" => :submenu, "label" => "ASAC scripts", "submenu" => :build_asac_menu, "title" => "ASAC" }
        ]
        items
      end

      def build_items_menu
        [
          { "type" => :submenu, "label" => "Items", "submenu" => :build_item_list, "title" => "Items", "mode" => :item_list, "item_kind" => :items },
          { "type" => :submenu, "label" => "Weapons", "submenu" => :build_item_list, "title" => "Weapons", "mode" => :item_list, "item_kind" => :weapons },
          { "type" => :submenu, "label" => "Armors", "submenu" => :build_item_list, "title" => "Armors", "mode" => :item_list, "item_kind" => :armors },
          { "type" => :submenu, "label" => "Shop for all items", "submenu" => :build_all_items_list, "title" => "All Items", "mode" => :item_list, "item_kind" => :all },
          { "type" => :action, "label" => "Selected item +1", "action" => :action_selected_item, "value" => 1, "support" => lambda { defined?(Scene_ItemBase) } },
          { "type" => :action, "label" => "Selected item +10", "action" => :action_selected_item, "value" => 10, "support" => lambda { defined?(Scene_ItemBase) } },
          { "type" => :action, "label" => "Selected item -1", "action" => :action_selected_item, "value" => -1, "support" => lambda { defined?(Scene_ItemBase) } },
          { "type" => :action, "label" => "Selected item -10", "action" => :action_selected_item, "value" => -10, "support" => lambda { defined?(Scene_ItemBase) } }
        ]
      end

      def build_teleport_menu
        items = []
        (1..8).each do |slot|
          index = slot - 1
          items << { "type" => :teleport, "label" => "Save slot #{slot}", "teleport_action" => :save, "slot" => index }
          items << { "type" => :teleport, "label" => "Load slot #{slot}", "teleport_action" => :load, "slot" => index }
        end
        items
      end

      def build_level_menu
        [1, 20, 40, 60, 80, 99].map do |level|
          { "type" => :action, "label" => "Level #{level}", "action" => :action_set_level, "value" => level }
        end
      end

      def build_stats_menu
        MacLauncherCheats.param_definitions.map do |param|
          {
            "type" => :number,
            "label" => "#{param["label"]} delta",
            "key" => "stat_#{param["id"]}",
            "store" => :menu,
            "min" => -9999,
            "max" => 9999,
            "step" => 1,
            "action" => :action_add_param,
            "param_index" => param["index"]
          }
        end
      end

      def build_gold_menu
        [
          {
            "type" => :number,
            "label" => "Gold delta",
            "key" => "gold_delta",
            "store" => :menu,
            "min" => -999999,
            "max" => 999999,
            "step" => 100,
            "action" => :action_gain_gold
          }
        ]
      end

      def build_asac_menu
        [
          { "type" => :action, "label" => "Run asac.q.rb", "action" => :action_run_asac, "value" => "q" },
          { "type" => :action, "label" => "Run asac.w.rb", "action" => :action_run_asac, "value" => "w" },
          { "type" => :action, "label" => "Run asac.e.rb", "action" => :action_run_asac, "value" => "e" },
          { "type" => :action, "label" => "Reload asac scripts", "action" => :action_reload_asac }
        ]
      end

      def build_item_list(item)
        kind = item["item_kind"]
        list = []
        case kind
        when :items
          list = $data_items if defined?($data_items)
        when :weapons
          list = $data_weapons if defined?($data_weapons)
        when :armors
          list = $data_armors if defined?($data_armors)
        when :all
          list = []
          list += $data_items if defined?($data_items)
          list += $data_weapons if defined?($data_weapons)
          list += $data_armors if defined?($data_armors)
        end
        list = [] unless list
        items = []
        list.each do |entry|
          next if entry.nil?
          next if entry.respond_to?(:name) && entry.name.to_s == ""
          items << { "type" => :item, "label" => entry.name.to_s, "item" => entry }
        end
        items
      end

      def build_all_items_list(item)
        item = item.dup
        item["item_kind"] = :all
        build_item_list(item)
      end

      def push_menu(items, title)
        resolved = resolve_items(items)
        menu = {
          "items" => resolved,
          "title" => title.to_s,
          "mode" => nil,
          "index" => 0,
          "top_index" => 0
        }
        @menu_stack << menu
        apply_menu_state if @list_window
      end

      def resolve_items(items)
        resolved = if items.respond_to?(:call)
                     items.call
                   elsif items.is_a?(Symbol)
                     send(items)
                   else
                     items
                   end
        resolved = [] unless resolved.is_a?(Array)
        resolved.select do |item|
          support = item["support"]
          support ? support.call : true
        end
      end

      def current_menu
        @menu_stack[@menu_stack.length - 1]
      end

      def apply_menu_state
        menu = current_menu
        return unless @list_window
        if @list_window.respond_to?(:disposed?) && @list_window.disposed?
          return
        end
        @list_window.set_items(menu["items"])
        @list_window.set_index(menu["index"], menu["top_index"])
        update_help_text
      end

      def update_help_text
        menu = current_menu
        title = menu ? menu["title"].to_s : "Cheats"
        help = help_text_for_menu(menu)
        return unless @help_window
        if @help_window.respond_to?(:disposed?) && @help_window.disposed?
          return
        end
        @help_window.set_lines([title, help])
      end

      def help_text_for_menu(menu)
        mode = menu ? menu["mode"] : nil
        if mode == :item_list
          qty = item_quantity
          qty_label = qty > 0 ? "+#{qty}" : qty.to_s
          "Qty #{qty_label}. Enter/Z: add/remove, Left/Right: quantity (Shift x10), Esc/X: back"
        elsif mode == :teleport
          "Enter/Z: save/load, Esc/X: back"
        else
          "Enter/Z: select, Left/Right: adjust, Esc/X: back"
        end
      end

      def pop_menu
        return false if @menu_stack.length <= 1
        @menu_stack.pop
        apply_menu_state
        true
      end

      def handle_input
        return if @list_window && @list_window.respond_to?(:disposed?) && @list_window.disposed?
        @list_window.update if @list_window.respond_to?(:update)
        if MacLauncherCheats.input_repeat?(MacLauncherCheats.keycode(:DOWN))
          @list_window.move_down
          sync_menu_index
        elsif MacLauncherCheats.input_repeat?(MacLauncherCheats.keycode(:UP))
          @list_window.move_up
          sync_menu_index
        elsif MacLauncherCheats.input_repeat?(MacLauncherCheats.keycode(:LEFT))
          handle_left_right(-1)
        elsif MacLauncherCheats.input_repeat?(MacLauncherCheats.keycode(:RIGHT))
          handle_left_right(1)
        elsif MacLauncherCheats.input_trigger?(MacLauncherCheats.keycode(:C))
          activate_current_item
        elsif MacLauncherCheats.input_trigger?(MacLauncherCheats.keycode(:B))
          close_or_back
        end
      end

      def sync_menu_index
        menu = current_menu
        return unless menu
        menu["index"] = @list_window.index
        menu["top_index"] = @list_window.top_index
      end

      def close_or_back
        return if pop_menu
        close_scene
      end

      def handle_left_right(delta)
        menu = current_menu
        return unless menu
        if menu["mode"] == :item_list
          adjust_item_quantity(delta)
          @list_window.refresh
          return
        end
        item = @list_window.current_item
        return unless item
        if item["type"] == :number
          adjust_number_item(item, delta)
          @list_window.refresh
        end
      end

      def activate_current_item
        item = @list_window.current_item
        return unless item
        case item["type"]
        when :toggle
          toggle_item(item)
          @list_window.refresh
        when :number
          if item["action"]
            run_action(item)
          else
            adjust_number_item(item, 1)
          end
          @list_window.refresh
        when :submenu
          open_submenu(item)
        when :action
          run_action(item)
        when :item
          apply_item_gain(item)
        when :teleport
          apply_teleport(item)
        end
      end

      def open_submenu(item)
        items = []
        if item["submenu"]
          handler = item["submenu"]
          if handler.is_a?(Symbol)
            arity = method(handler).arity rescue 0
            items = arity == 0 ? send(handler) : send(handler, item)
          elsif handler.respond_to?(:call)
            items = handler.call(item)
          end
        end
        title = item["title"] || item["label"] || "Menu"
        menu = {
          "items" => resolve_items(items),
          "title" => title.to_s,
          "mode" => item["mode"],
          "index" => 0,
          "top_index" => 0
        }
        @menu_stack << menu
        apply_menu_state
      end

      def menu_state_value(item, fallback)
        key = item["key"]
        return fallback unless key
        if @menu_state[key].nil?
          @menu_state[key] = fallback
        end
        @menu_state[key]
      end

      def set_menu_state_value(item, value)
        key = item["key"]
        return unless key
        @menu_state[key] = value
      end

      def adjust_number_item(item, delta)
        if item["store"] == :menu
          current = menu_state_value(item, item["default"] || 0)
          step = item["step"] ? item["step"].to_f : 1.0
          min = item["min"]
          max = item["max"]
          next_value = current.to_f + (delta * step)
          next_value = min if !min.nil? && next_value < min
          next_value = max if !max.nil? && next_value > max
          next_value = next_value.to_i if step == 1.0
          set_menu_state_value(item, next_value)
        else
          MacLauncherCheats.adjust!(item["key"], delta, item)
        end
      end

      def toggle_item(item)
        if item["store"] == :menu
          current = menu_state_value(item, false)
          set_menu_state_value(item, !current)
        else
          MacLauncherCheats.toggle!(item["key"])
        end
      end

      def label_for_item(item)
        if item["type"] == :teleport
          slot = item["slot"]
          slot_label = slot ? (slot + 1).to_s : "?"
          data = MacLauncherCheats.load_teleport_slot(slot)
          action = item["teleport_action"] == :save ? "Save slot" : "Teleport slot"
          if item["teleport_action"] == :save
            if data
              location = "Saved: Map #{data[0]} (#{data[1]},#{data[2]})"
            else
              if defined?($game_map) && defined?($game_player) &&
                   $game_map.respond_to?(:map_id) && $game_player.respond_to?(:x) &&
                   $game_player.respond_to?(:y)
                location = "Current: Map #{$game_map.map_id} (#{$game_player.x},#{$game_player.y})"
              else
                location = "Current: ?"
              end
            end
          else
            location = data ? "Map #{data[0]} (#{data[1]},#{data[2]})" : "Empty"
          end
          return "#{action} #{slot_label} (#{location})"
        end
        item["label"]
      end

      def value_for_item(item)
        case item["type"]
        when :toggle
          value = if item["store"] == :menu
                    menu_state_value(item, false)
                  else
                    MacLauncherCheats.bool(item["key"])
                  end
          value ? "ON" : "OFF"
        when :number
          value = if item["store"] == :menu
                    menu_state_value(item, item["default"] || 0)
                  else
                    MacLauncherCheats.num(item["key"], MacLauncherCheats::DEFAULTS[item["key"]] || 0)
                  end
          if item["options"] && item["options"][value.to_i]
            item["options"][value.to_i]
          elsif item["step"] && item["step"].to_f < 1
            format("%.1f", value.to_f)
          else
            value.to_i.to_s
          end
        when :submenu
          ">"
        when :item
          qty = item_quantity
          owned = MacLauncherCheats.item_count(item["item"])
          "#{owned} (#{qty > 0 ? "+" : ""}#{qty})"
        when :teleport
          ""
        else
          ""
        end
      end

      def item_quantity
        value = @menu_state["item_quantity"]
        value = 1 if value.nil?
        value
      end

      def adjust_item_quantity(delta)
        step = MacLauncherCheats.shift_pressed? ? 10 : 1
        value = item_quantity + (delta * step)
        value = 999 if value > 999
        value = -999 if value < -999
        @menu_state["item_quantity"] = value
        update_help_text
      end

      def apply_item_gain(item)
        amount = item_quantity
        if amount == 0
          MacLauncherCheats.play_buzzer
          return
        end
        if MacLauncherCheats.gain_item(item["item"], amount)
          MacLauncherCheats.play_ok
        else
          MacLauncherCheats.play_buzzer
        end
        @list_window.refresh
      end

      def apply_teleport(item)
        slot = item["slot"]
        if item["teleport_action"] == :save
          if defined?($game_map) && defined?($game_player) && $game_player.respond_to?(:x)
            map_id = $game_map.respond_to?(:map_id) ? $game_map.map_id : 0
            MacLauncherCheats.save_teleport_slot(slot, map_id, $game_player.x, $game_player.y)
            MacLauncherCheats.play_ok
          else
            MacLauncherCheats.play_buzzer
          end
        else
          data = MacLauncherCheats.load_teleport_slot(slot)
          if data && MacLauncherCheats.teleport_to(data[0], data[1], data[2])
            if defined?(SceneManager) && SceneManager.respond_to?(:goto)
              SceneManager.goto(Scene_Map)
            elsif defined?($scene)
              $scene = Scene_Map.new
            end
            MacLauncherCheats.play_ok
          else
            MacLauncherCheats.play_buzzer
          end
        end
        @list_window.refresh
      end

      def run_action(item)
        action = item["action"]
        return unless action
        ok = send(action, item)
        if ok
          MacLauncherCheats.play_ok
        else
          MacLauncherCheats.play_buzzer
        end
      end

      def action_heal_party(_item)
        return false if MacLauncherCheats.party_members.empty?
        MacLauncherCheats.recover_party
        true
      end

      def action_max_hp(_item)
        return false if MacLauncherCheats.party_members.empty?
        MacLauncherCheats.set_party_hp_max
        true
      end

      def action_max_mp(_item)
        return false if MacLauncherCheats.party_members.empty?
        MacLauncherCheats.set_party_mp_max
        true
      end

      def action_party_hp_one(_item)
        return false if MacLauncherCheats.party_members.empty?
        MacLauncherCheats.set_party_hp(1)
        true
      end

      def action_party_mp_one(_item)
        return false if MacLauncherCheats.party_members.empty?
        MacLauncherCheats.set_party_mp(1)
        true
      end

      def action_enemy_hp_one(_item)
        return false if MacLauncherCheats.troop_alive_members.empty?
        MacLauncherCheats.set_enemy_hp(1)
        true
      end

      def action_enemy_kill(_item)
        return false if MacLauncherCheats.troop_alive_members.empty?
        MacLauncherCheats.set_enemy_hp(0)
        true
      end

      def action_enemy_heal(_item)
        return false if MacLauncherCheats.troop_members.empty?
        MacLauncherCheats.recover_enemies
        true
      end

      def action_gain_all_items(_item)
        MacLauncherCheats.gain_all_items > 0
      end

      def action_toggle_fullscreen(_item)
        return false unless defined?(Graphics) && Graphics.respond_to?(:toggle_fullscreen)
        Graphics.toggle_fullscreen
        true
      end

      def action_toggle_ratio(_item)
        return false unless defined?(Graphics) && Graphics.respond_to?(:toggle_ratio)
        Graphics.toggle_ratio
        true
      end

      def action_set_level(item)
        value = item["value"].to_i
        return false if value <= 0 || MacLauncherCheats.party_members.empty?
        MacLauncherCheats.change_level_all(value)
        true
      end

      def action_add_param(item)
        delta = menu_state_value(item, 0)
        return false if delta == 0 || MacLauncherCheats.party_members.empty?
        MacLauncherCheats.add_param_all(item["param_index"], delta)
        true
      end

      def action_gain_gold(item)
        amount = menu_state_value(item, 0).to_i
        return false if amount == 0
        MacLauncherCheats.gain_gold(amount)
      end

      def action_god_stats(_item)
        return false if MacLauncherCheats.party_members.empty?
        MacLauncherCheats.param_definitions.each do |param|
          next if ["mhp", "mmp", "msp"].include?(param["id"])
          MacLauncherCheats.add_param_all(param["index"], 9999)
        end
        true
      end

      def action_selected_item(item)
        amount = item["value"].to_i
        return false unless defined?(Scene_ItemBase)
        scene = if defined?(SceneManager) && SceneManager.respond_to?(:scene)
                  SceneManager.scene
                elsif defined?($scene)
                  $scene
                end
        return false unless scene && scene.is_a?(Scene_ItemBase)
        return false unless scene.respond_to?(:item)
        target = scene.item
        return false unless target
        MacLauncherCheats.gain_item(target, amount)
      end

      def action_run_asac(item)
        key = item["value"].to_s
        return false if key == ""
        MacLauncherCheats.run_asac_script(key)
      end

      def action_reload_asac(_item)
        MacLauncherCheats.load_asac_scripts
        true
      end

      def action_open_save(_item)
        if defined?(SceneManager) && SceneManager.respond_to?(:call)
          SceneManager.call(Scene_Save)
          return true
        elsif defined?($scene)
          $scene = Scene_Save.new
          return true
        end
        false
      end

      def close_scene
        if defined?(SceneManager)
          if SceneManager.respond_to?(:return)
            SceneManager.return
          elsif SceneManager.respond_to?(:goto)
            SceneManager.goto(Scene_Map)
          end
        else
          $scene = Scene_Map.new
        end
      end
    end

    if defined?(Scene_Base)
      class Scene_MacLauncherCheats < Scene_Base
        include MacLauncherCheatsSceneLogic

        def start
          super
          mlc_start
        end

        def update
          super
          mlc_update
        end

        def terminate
          super
          mlc_terminate
        end
      end
    else
      class Scene_MacLauncherCheats
        include MacLauncherCheatsSceneLogic

        def start
          mlc_start
        end

        def update
          mlc_update
        end

        def terminate
          mlc_terminate
        end

        def main
          start
          Graphics.transition
          while $scene == self
            Graphics.update
            Input.update
            update
          end
          Graphics.freeze
          terminate
        end
      end
    end
  end

  if defined?(Scene_Map) && Scene_Map.method_defined?(:update)
    class Scene_Map
      alias maclauncher_cheats_update update
      def update
        maclauncher_cheats_update
        MacLauncherCheats.check_hotkey
        MacLauncherCheats.check_debug_hotkey
      end
    end
  end
end
