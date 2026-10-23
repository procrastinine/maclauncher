// Prepare shared resources before asking a runtime to change its renderer.
// The module owns its renderer transaction; the shared publication retains
// the original launch and accepted files until the final synchronous commit.
const warn = require("../modules/shared/graphics-warning");
async function apply(entry, options, prepare, createPublication) {
  return applyAttempt(entry, options, prepare, createPublication, false);
}
const SOURCE_FAILURES = new Set(["GRAPHICS_SOURCE_UNAVAILABLE", "GRAPHICS_SOURCE_ACK_INVALID", "GRAPHICS_SOURCE_REJECTED", "GRAPHICS_SOURCE_TIMEOUT"]);
const reduction = source => source && (source.automatic === true || Number.isSafeInteger(source.height) && source.height > 0 || Number.isFinite(source.multiplier) && source.multiplier > 1);
async function applyAttempt(entry, options, prepare, createPublication, retrying) {
  const publication = createPublication({isCurrent: options.isCurrent});
  let sourceUpdate, sourceFailure, failedControl, sourceReductionRequested = false, rollbackTask, runtimeUse, exposed = false;
  // A renderer may need to restore the shared contract while its previous
  // image is still held. Repeated compensation must share the same source
  // restoration epoch, including the outer error path.
  const rollback = () => rollbackTask ||= (async () => {
    const restored = publication.rollback();
    if (restored === false && options.isCurrent())
      throw new Error("The accepted graphics settings changed before they could be restored.");
    if (sourceUpdate && restored !== false && await sourceUpdate.rollback() === false && options.isCurrent())
      throw new Error("The render source changed before it could be restored.");
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
      publication.rollback();
      return prepared;
    }
    options.signal?.throwIfAborted();
    const sourceControl = options.launchBinding?.sourceControl;
    if (!retrying && options.running && sourceControl &&
        Object.hasOwn(publication.metadata || {}, "sourceResolutionCandidate")) {
      const candidate = publication.metadata.sourceResolutionCandidate;
      sourceReductionRequested = reduction(candidate) || reduction(prepared?.preparationStatus?.sourceResolution?.requested);
      const preparedNodes = prepared?.document?.nodes;
      // Virtual acknowledgement includes a completed processed image. First
      // model initialization can exceed an ordinary renderer property ACK.
      // A prepared document is authoritative; Simple's setter can return no
      // document while its selected neural chain is prepared internally.
      const slowVirtual = sourceControl.control === "virtual" && (Array.isArray(preparedNodes)
        ? preparedNodes.some(node => node.enabled && node.kind === "neural")
        : entry.effects == null && entry.graphics?.neuralMethod === "mlx-dlss");
      try {
        sourceUpdate = await require("../modules/shared/reshade/source-controls").stage(
          candidate,
          {binding: sourceControl, publication, signal: options.signal, isCurrent: options.isCurrent,
            ...(slowVirtual ? {timeoutMs: 30000} : {})});
      } catch (error) { sourceFailure = error;failedControl = sourceControl.control;throw error; }
    }
    const publish = async () => {
      options.signal?.throwIfAborted();
      publication.check?.();
      // A commit may expose some bytes before a later write fails. Once it
      // starts, preserve candidate leases until the owning game retires.
      exposed = true;runtimeUse?.retain();
      publication.commit();
      if (sourceUpdate) try { await sourceUpdate.wait(); }
      catch (error) { sourceFailure = error;failedControl = sourceControl.control;throw error; }
      return true;
    };
    const result = options.running && typeof options.withGraphicsUpdate === "function"
      ? await options.withGraphicsUpdate(entry, {...stagedOptions, prepared}, publish)
      : await publish();
    if (result?.deferred === true) await rollback();
    return prepared;
  } catch (error) {
    let restoreError;
    try { await rollback(); } catch (failure) { restoreError = failure; }
    if (options.isCurrent()) {
      if (restoreError) throw new AggregateError([error, restoreError],
        `${error.message || "Graphics settings could not be updated."} Previous render settings could not be restored.`);
      if (options.signal?.aborted && options.signal.reason?.code === "GRAPHICS_RESET_SUPERSEDED" &&
          (error === options.signal.reason || error.name === "AbortError")) return {deferred: true};
      if (!retrying && sourceReductionRequested && error === sourceFailure && SOURCE_FAILURES.has(error.code) && !options.signal?.aborted &&
          ["engine", "drawable", "virtual"].includes(failedControl)) {
        const reason = String(error.message || "The renderer did not apply the source settings.").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 512);
        warn(options.logger, `[Graphics] Source allocation failed: ${reason} Retaining the accepted source and retrying completed-frame processing.`);
        // Restore the accepted source before any second preparation. The retry
        // owns a fresh publication and cannot issue another native source (or
        // source-null) command, even if preparation leaves candidate metadata.
        return applyAttempt(entry, {...options, sourceResolutionFailures: {...options.sourceResolutionFailures, [failedControl]: reason}},
          prepare, createPublication, true);
      }
      throw error;
    }
  } finally {
    if (runtimeUse && !exposed) {
      try {await runtimeUse.release();}
      catch (error) {warn(options.logger, "Temporary graphics model access could not be released.", error.message);}
    }
  }
}

module.exports = {apply};
