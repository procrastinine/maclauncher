const fs = require("node:fs"), path = require("node:path");
const Detect = require("./detect");
const Writable = require("../shared/writable-input");

function statePath(entry, context = {}) {
  if (!path.isAbsolute(context.userDataDir || "") || !/^[\w-]+$/.test(entry.gameId || "")) return null;
  return path.join(context.userDataDir, "games", entry.gameId, "modules", "video", "playback.json");
}
// Playback positions. A damaged state file is kept beside it, and its
// readable positions remain. A file that cannot be read now, or another
// format, is not replaced (`unreadable`).
function read(entry, context) {
  const empty = { schema: 1, videos: {} };
  try {
    const file = statePath(entry, context), stat = file && fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return empty;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return { ...empty, unreadable: true };
    let preserved = false;
    const value = require("../../core/json-files").readJsonDocument(file, { onPreserved: () => { preserved = true; } });
    const videos = value?.videos && typeof value.videos === "object" && !Array.isArray(value.videos) ? value.videos : null;
    if (value?.schema === 1 && videos) return value;
    return preserved ? { ...empty, ...(videos ? { videos } : {}) } : { ...empty, unreadable: true };
  } catch { return { ...empty, unreadable: true }; }
}
function files(entry) {
  if (entry.moduleData?.playlist) return Detect.topLevelVideos(entry.gamePath).map(video => video.gamePath);
  if (!path.isAbsolute(entry.gamePath || "") || !fs.statSync(entry.gamePath, { throwIfNoEntry: false })?.isFile())
    throw new Error("The video file was not found. Import it from its current location.");
  return [entry.gamePath];
}
function prepare(entry, context = {}) {
  const videos = files(entry);
  if (!videos.length) throw new Error("No top-level videos remain in this playlist folder.");
  const state = read(entry, context), keys = videos.map(file => path.basename(file));
  const selected = entry.moduleData?.playlistVideo;
  let index = selected ? keys.indexOf(selected) : -1;
  if (selected && index < 0) throw new Error("The selected video is no longer in this folder. Choose Automatic or another video in the inspector.");
  if (index < 0) {
    const previous = keys.indexOf(state.lastVideo);
    index = previous < 0 ? 0 : state.videos[keys[previous]]?.finished === true ? (previous + 1) % videos.length : previous;
  }
  return { files: videos, keys, index, file: videos[index], state, statePath: state.unreadable ? null : statePath(entry, context) };
}
function playableEntry(entry, context) { return { ...entry, gamePath: prepare(entry, context).file }; }
function options(entry, _payload, context) {
  const plan = prepare({ ...entry, moduleData: { ...entry.moduleData, playlistVideo: "" } }, context);
  const selected = entry.moduleData?.playlistVideo || "";
  return { value: selected, options: [{ value: "", label: `Automatic · ${path.basename(plan.file)}` },
    ...plan.keys.map(value => ({ value, label: value }))],
    ...(selected && !plan.keys.includes(selected) ? { description: "The selected video is missing. Choose Automatic or another video." } : {}) };
}
function select(entry, { value } = {}, context) {
  if (context.isGameRunning?.()) throw new Error("Stop playback before changing the starting video.");
  if (typeof value !== "string" || value && !files(entry).some(file => path.basename(file) === value))
    throw new Error("Choose a top-level video from this playlist.");
  entry.moduleData = { ...entry.moduleData, playlistVideo: value };
  context.onEntryChange?.({ moduleData: entry.moduleData });
  return options(entry, {}, context);
}
function accepts(entry, source) {
  try {
    const actual = fs.realpathSync(source);
    if (!entry.moduleData?.playlist) return actual === fs.realpathSync(entry.gamePath);
    return path.dirname(actual) === fs.realpathSync(entry.gamePath) &&
      require("./manifest.json").detection.fileExtensions.includes(path.extname(actual).toLowerCase()) && fs.statSync(actual).isFile();
  } catch { return false; }
}
async function watch(child, socket, plan, entry, context, dependencies = {}) {
  const connect = dependencies.connect || require("./live").connect;
  let ipc, stopped = false;
  const state = { schema: 1, videos: Object.fromEntries(plan.keys.filter(key => Object.hasOwn(plan.state.videos, key)).map(key => [key, plan.state.videos[key]])) };
  let current = null, position = 0, duration = 0, finished = false, dirty = false, timer;
  const write = () => {
    if (!dirty || !plan.statePath) return;
    Writable.atomicWrite(plan.statePath, JSON.stringify(state), { root: context.userDataDir });dirty = false;
  };
  const save = () => {
    if (!current) return;
    state.lastVideo = current;
    Object.defineProperty(state.videos, current, { value: { position, duration, finished }, enumerable: true, configurable: true, writable: true });dirty = true;
  };
  const cleanup = () => {
    if (stopped) return;
    stopped = true;clearInterval(timer);save();
    try { write(); } catch (error) { context.logger?.warn?.("Video progress could not be saved.", error.message); }
    ipc?.close();
  };
  child.once("close", cleanup);
  try {
    const deadline = Date.now() + 8000;
    while (!ipc && !stopped) {
      context.signal?.throwIfAborted();
      try { ipc = await connect(socket, { signal: context.signal, timeout: 1000 }); }
      catch (error) {
        if (Date.now() >= deadline || context.signal?.aborted || stopped) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (!ipc || stopped) { ipc?.close();throw new Error("The video player exited before playback became ready."); }
    const command = value => ipc.request(value, { signal: context.signal });
    let loading = Promise.resolve(), loadPending = false;
    async function loaded() {
      const source = await command(["get_property", "path"]).catch(error => {
        if (/property unavailable/.test(error.message)) return null;
        throw error;
      });
      if (!source) return;
      const index = plan.files.findIndex(file => {
        try { return fs.realpathSync(file) === fs.realpathSync(source); } catch { return false; }
      });
      if (index < 0 || stopped) return;
      const key = plan.keys[index];
      if (key === current) return;
      // A socket can open before the first demuxer finishes loading. The
      // file-loaded event retries this path once seeking is available.
      const length = await command(["get_property", "duration"]).catch(() => null);
      if (!Number.isFinite(length)) return;
      save();current = key;position = 0;duration = 0;finished = false;
      const previous = state.videos[key];
      if (previous?.finished !== true && Number.isFinite(previous?.position) && previous.position > 0) {
        await command(["seek", previous.position, "absolute+exact"]);position = previous.position;
      }
      duration = length;
      save();write();
    }
    const queueLoaded = () => {
      if (loadPending) return loading;
      loadPending = true;
      loading = loading.then(loaded).catch(error => {
        if (!stopped) context.logger?.warn?.("Video progress could not be restored.", error.message);
      }).finally(() => { loadPending = false; });
      return loading;
    };
    ipc.onEvent(event => { try {
      if (stopped) return;
      if (event.event === "start-file") { save();write();current = null;position = 0;duration = 0;finished = false; }
      if (event.event === "file-loaded") void queueLoaded();
      if (event.event === "end-file") {
        if (event.reason === "eof") finished = true;
        save();write();
      }
      if (event.event !== "property-change") return;
      if (!current) {
        if (["time-pos", "duration"].includes(event.name) && Number.isFinite(event.data)) void queueLoaded();
        return;
      }
      if (event.name === "time-pos" && Number.isFinite(event.data)) {
        position = Math.max(0, event.data);
        if (duration > 0 && position < duration - 1) finished = false;
      }
      if (event.name === "duration" && Number.isFinite(event.data)) duration = Math.max(0, event.data);
      if (event.name === "eof-reached" && event.data === true) { finished = true;save();write(); }
    } catch (error) { context.logger?.warn?.("Video progress could not be saved.", error.message); } });
    // Both upstream mpv and the decoded host expose this same local IPC API.
    // Append files without restarting the initial video, then restore its
    // alphabetical index so previous/next controls use the complete playlist.
    for (const file of plan.files) if (file !== plan.file) await command(["loadfile", file, "append"]);
    if (plan.index > 0) await command(["playlist-move", 0, plan.index + 1]);
    for (const [id, name] of ["time-pos", "duration", "eof-reached"].entries()) await command(["observe_property", id + 1, name]);
    await queueLoaded();
    const initialDuration = await command(["get_property", "duration"]).catch(() => null);
    if (Number.isFinite(initialDuration)) duration = initialDuration;
    if (stopped || child.exitCode != null || child.signalCode != null) throw new Error("The video player exited before playback became ready.");
    timer = setInterval(() => { try { save();write(); } catch (error) { context.logger?.warn?.("Video progress could not be saved.", error.message); } }, 5000);
    timer.unref?.();
    return cleanup;
  } catch (error) { cleanup();throw error; }
}
module.exports = { statePath, read, files, prepare, playableEntry, options, select, accepts, watch };
