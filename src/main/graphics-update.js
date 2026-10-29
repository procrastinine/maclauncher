// Prepare shared resources before asking a runtime to change its renderer.
// The module owns its renderer transaction; the shared publication retains
// the original launch and accepted files until the final synchronous commit.
// `onPublication` reports a committed publication (after its source change
// was acknowledged) and `onRollback` a committed one that was restored or is
// kept while the next source path is tried. Both feed the status owner.
const warn = require("../modules/shared/graphics-warning");
async function apply(entry, options, prepare, createPublication) {
  return applyAttempt(entry, options, prepare, createPublication);
}
const SOURCE_FAILURES = new Set(["GRAPHICS_SOURCE_UNAVAILABLE", "GRAPHICS_SOURCE_ACK_INVALID", "GRAPHICS_SOURCE_REJECTED", "GRAPHICS_SOURCE_TIMEOUT"]);
const reduction = source => source && (source.automatic === true || Number.isSafeInteger(source.height) && source.height > 0 || Number.isFinite(source.multiplier) && source.multiplier > 1);
// A graph without processing runs no executor; native code acknowledges it as
// pass-through.
const processed = entry => require("../modules/shared/effects/execution-requirements").analyze(entry).needed.processor;
function report(options, name, value) {
  try { options[name]?.(value); }
  catch (error) { warn(options.logger, "Graphics status could not be updated.", error?.message || String(error)); }
}
// restoreEarlier restores an earlier attempt whose graph stayed exposed while
// this attempt prepared the next source path.
async function applyAttempt(entry, options, prepare, createPublication, restoreEarlier) {
  const publication = createPublication({isCurrent: options.isCurrent});
  let sourceUpdate, sourceFailure, failedControl, sourceControl, sourceReductionRequested = false, rollbackTask, runtimeUse, exposed = false, slowVirtual = false;
  const restoredSources = [];
  // A renderer may need to restore the shared contract while its previous
  // image is still held. Repeated compensation must share the same source
  // restoration epoch, including the outer error path.
  const rollback = () => rollbackTask ||= (async () => {
    if (exposed) report(options, "onRollback", {retrying: false});
    const restored = publication.rollback();
    if (restored === false && options.isCurrent())
      throw new Error("The accepted graphics settings changed before they could be restored.");
    const failures = [];
    if (restored !== false) for (const update of [sourceUpdate, ...restoredSources.toReversed()].filter(Boolean)) {
      try {
        if (await update.rollback() === false && options.isCurrent()) throw new Error("The render source changed before it could be restored.");
      } catch (error) {failures.push(error);}
    }
    if (restoreEarlier) try {await restoreEarlier();} catch (error) {failures.push(error);}
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "The accepted render sources could not be restored.");
  })();
  const stagedOptions = {...options, publication, rollbackShared: rollback};
  try {
    if (!options.isCurrent()) return;
    options.signal?.throwIfAborted();
    if (options.graphicsRuntimeUse) {
      runtimeUse = options.graphicsRuntimeUse.begin({signal: options.signal});
      stagedOptions.useRuntime = identity => runtimeUse.useRuntime(identity);
      stagedOptions.useModel = version => runtimeUse.useRuntime({managerId: "graphics-models", version});
    }
    const prepared = await prepare(stagedOptions);
    if (!options.isCurrent() || prepared?.deferred === true || publication.deferred) {
      if (restoreEarlier) await rollback();else publication.rollback();
      return prepared;
    }
    options.signal?.throwIfAborted();
    const SourceControls = require("../modules/shared/reshade/source-controls");
    const hasSourceSelection = Object.hasOwn(publication.metadata || {}, "sourceResolutionControl");
    sourceControl = hasSourceSelection
      ? SourceControls.bindings(options.launchBinding).find(binding => binding.control === publication.metadata.sourceResolutionControl)
      : options.launchBinding?.sourceControl;
    if (!options.sourceResolutionFailures?.[sourceControl?.control] && options.running && sourceControl &&
        Object.hasOwn(publication.metadata || {}, "sourceResolutionCandidate")) {
      const candidate = publication.metadata.sourceResolutionCandidate;
      sourceReductionRequested = reduction(candidate) || reduction(prepared?.preparationStatus?.sourceResolution?.requested);
      const preparedNodes = prepared?.document?.nodes;
      // Virtual acknowledgement includes a completed processed image. First
      // model initialization can exceed an ordinary renderer property ACK.
      slowVirtual = sourceControl.control === "virtual" && Array.isArray(preparedNodes) &&
        preparedNodes.some(node => node.enabled && node.kind === "neural");
      try {
        sourceUpdate = await SourceControls.stage(
          candidate,
          {binding: sourceControl, publication, signal: options.signal, isCurrent: options.isCurrent,
            ...(slowVirtual ? {timeoutMs: 30000} : {})});
      } catch (error) { sourceFailure = error;failedControl = sourceControl.control;throw error; }
    }
    const publish = async () => {
      options.signal?.throwIfAborted();
      publication.check?.();
      if (options.running && hasSourceSelection) {
        // Two allocation owners must not halve the same source. Retire the
        // previous channel inside the renderer transaction, then expose the
        // prepared graph and selected source together. Rollback reverses both.
        for (const binding of SourceControls.active(options.launchBinding)) {
          if (binding.file === sourceControl?.file) continue;
          const update = SourceControls.stage(null, {binding, signal: options.signal, isCurrent: options.isCurrent});
          restoredSources.push(update);await update.wait();
        }
        options.signal?.throwIfAborted();publication.check?.();
      }
      // A commit may expose some bytes before a later write fails. Once it
      // starts, preserve candidate leases until the owning game retires.
      exposed = true;runtimeUse?.retain();
      // A static completed image may finish before the inspector's first
      // status read, and a graph without processing is acknowledged as
      // pass-through only while the lease is held. Prime metadata before
      // publication; native control polling observes the real work, with no
      // extra frame or GPU submission.
      if (options.running)
        require("../modules/shared/reshade/runtime-status").prime(options.launchBinding?.runtimeStatus, {userDataDir: options.userDataDir});
      const committedAt = Date.now();
      publication.commit();
      if (sourceUpdate) try { await sourceUpdate.wait(); }
      catch (error) { sourceFailure = error;failedControl = sourceControl.control;throw error; }
      // First model initialization and a virtual source take longer to confirm.
      report(options, "onPublication", {prepared, committedAt, documentRevision: prepared?.document?.revision,
        slow: slowVirtual || Boolean(prepared?.document?.nodes?.some(node => node.enabled && (node.kind === "neural" || node.modelOperation)))});
      return true;
    };
    const result = options.running && typeof options.withGraphicsUpdate === "function"
      ? await options.withGraphicsUpdate(entry, {...stagedOptions, prepared}, publish)
      : await publish();
    if (result?.deferred === true) await rollback();
    return prepared;
  } catch (error) {
    let restoreError, exposedCandidate;
    const recoverable = !options.sourceResolutionFailures?.[failedControl] && sourceReductionRequested && error === sourceFailure && SOURCE_FAILURES.has(error.code) &&
      !options.signal?.aborted && ["engine", "drawable", "virtual"].includes(failedControl);
    if (recoverable && sourceUpdate && publication.committed && publication.release && options.isCurrent()) {
      // The committed graph stays visible while the next source path is
      // prepared, so the game never returns to the previous graph between two
      // selected ones. Only the failed allocation is restored now; a failure
      // of the next path restores this attempt too.
      const failed = sourceUpdate;sourceUpdate = undefined;publication.release(sourceControl.file);
      try {
        if (await failed.rollback() === false && options.isCurrent()) throw new Error("The render source changed before it could be restored.");
        exposedCandidate = rollback;
      } catch (failure) { restoreError = failure; }
    }
    if (!exposedCandidate) try { await rollback(); } catch (failure) { restoreError ||= failure; }
    if (options.isCurrent()) {
      if (restoreError) throw new AggregateError([error, restoreError],
        `${error.message || "Graphics settings could not be updated."} Previous render settings could not be restored.`);
      if (options.signal?.aborted && options.signal.reason?.code === "GRAPHICS_RESET_SUPERSEDED" &&
          (error === options.signal.reason || error.name === "AbortError")) return {deferred: true};
      if (recoverable) {
        const reason = String(error.message || "The renderer did not apply the source settings.").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 512);
        warn(options.logger, `[Graphics] Source allocation failed: ${reason} Trying the next source path, then completed-frame processing.`);
        if (exposedCandidate) report(options, "onRollback", {retrying: true});
        // Each failed control is excluded from the next shared decision. A
        // legacy launch has one channel; a newer launch can try its dormant
        // virtual owner before falling back to completed-frame processing.
        return applyAttempt(entry, {...options, sourceResolutionFailures: {...options.sourceResolutionFailures, [failedControl]: reason}},
          prepare, createPublication, exposedCandidate);
      }
      throw error;
    }
    if (exposedCandidate) try { await exposedCandidate(); } catch {}
  } finally {
    if (runtimeUse && !exposed) {
      try {await runtimeUse.release();}
      catch (error) {warn(options.logger, "Temporary graphics model access could not be released.", error.message);}
    }
  }
}

module.exports = {apply, processed};
