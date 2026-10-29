// One status record per game: desired, published and acknowledged revisions,
// the reason for any gap, row states and model acquisitions. It is event
// driven. A timer runs only for an outstanding publication's confirmation, a
// throttled event or download progress; a settled game holds none.
const THROTTLE_MS = 33, PROGRESS_MS = 250, CONFIRM_MS = 5000, SLOW_CONFIRM_MS = 30000, PREPARING_CONFIRM_MS = 120000, PROBES = [50, 100, 200, 400, 500];
const TERMINAL = new Set(["saved", "applied", "partial", "deferred", "rejected", "unconfirmed", "invalid"]);
const REASONS = Object.freeze({
  unbound: "This game was started without live graphics editing. Changes apply on the next launch.",
  stopped: "The game stopped before this change was applied. It applies on the next launch.",
  retained: "The running game kept its current graphics. This change applies on the next launch.",
  unconfirmed: "The game has not reported this change. It applies when the game draws its next frame.",
  rejected: "The game could not apply this change.",
  consent: "Waiting for download approval.",
  installing: "Installing model…",
  declined: "Download declined. Select the model again or install it in Runtimes.",
  cancelled: "Download cancelled.",
  failed: "The model could not be downloaded.",
  downloadingNext: "The model is downloading. The change applies on the next launch.",
  readyNext: "The model is installed. The change applies on the next launch."
});
const clean = (value, fallback) => String(value || fallback || "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 512);
const percent = job => job.bytes > 0 ? Math.max(0, Math.min(100, Math.floor(job.received / job.bytes * 100))) : 0;
const defaultRowKey = node => require("../modules/shared/effects/selection-key.mjs").effectSelectionKey(node);

function createGraphicsStatusOwner({send = () => {}, clock = {now: Date.now, setTimeout, clearTimeout}, models = {}, resume = () => {},
  rowKey = defaultRowKey, logger} = {}) {
  const records = new Map(), jobs = new Map();
  const warn = (message, error) => { try { logger?.warn?.(message, error?.message || error); } catch {} };
  const blank = gamePath => ({gamePath, desiredSeq: 0, desiredRevision: undefined, planSource: undefined, plan: null, planChanged: false,
    running: false, live: false, launchId: undefined, pid: undefined, phase: "saved", reason: undefined, published: undefined, acknowledged: undefined,
    retained: undefined, rows: {}, waits: new Map(), blocked: new Map(), extra: {}, watcher: null, reader: null, deadline: null, probe: null, confirmation: null, nativePreparing: false,
    timer: null, queued: false, dirty: false, sentAt: -Infinity});
  function record(gamePath) {
    let value = records.get(gamePath);
    if (!value) records.set(gamePath, value = blank(gamePath));
    return value;
  }
  // The displayed phase. An acquisition overlays the publication of the
  // remaining rows; an unreadable stored plan overrides everything.
  const active = value => [...value.waits.values()].map(wait => jobs.get(wait.key)).filter(job => job && !value.waits.get(job.key)?.exited);
  function phase(value) {
    if (value.planSource === "invalid") return "invalid";
    return value.running && active(value).length ? "acquiring" : value.phase === "published" && value.nativePreparing ? "preparing" : value.phase;
  }
  function jobReason(job) {
    return job.state === "consent" ? REASONS.consent : job.state === "installing" ? REASONS.installing : `Downloading model… ${percent(job)}%`;
  }
  function snapshot(value) {
    const shown = phase(value), jobsNow = value.running ? active(value) : [], rows = {...value.rows};
    for (const job of jobsNow) for (const row of value.waits.get(job.key).rows) rows[row.id] = {state: "acquiring", reason: jobReason(job)};
    const job = jobsNow[0];
    return {gamePath: value.gamePath, desiredSeq: value.desiredSeq, ...(value.desiredRevision ? {desiredRevision: value.desiredRevision} : {}),
      ...(value.planSource ? {planSource: value.planSource} : {}), running: value.running, live: value.live,
      ...(value.launchId ? {launchId: value.launchId} : {}), ...(value.pid ? {pid: value.pid} : {}), phase: shown,
      ...(value.published ? {published: {...value.published}} : {}), ...(value.acknowledged ? {acknowledged: {...value.acknowledged}} : {}),
      ...(value.retained ? {retained: {...value.retained}} : {}),
      ...(shown === "acquiring" ? {reason: jobReason(job)} : value.reason ? {reason: value.reason} : {}), rows,
      ...(job ? {acquisition: {id: job.key, operation: job.operation, label: job.source.label || job.operation, bytes: job.bytes, received: job.received,
        state: job.state}} : {})};
  }
  function flush(value) {
    value.queued = false;
    if (!value.dirty) return;
    value.dirty = false;value.sentAt = clock.now();
    const event = {gamePath: value.gamePath, status: snapshot(value), ...(value.planChanged && value.plan ? {plan: value.plan} : {})};
    value.planChanged = false;
    try { send(event, value.extra); } catch (error) { warn("Graphics status could not be delivered.", error); }
  }
  // One microtask coalesces a burst; non-terminal events are throttled to one
  // per 33 ms per game and terminal transitions go out immediately.
  function notify(value, urgent = TERMINAL.has(phase(value))) {
    value.dirty = true;
    if (urgent || clock.now() - value.sentAt >= THROTTLE_MS) {
      if (value.timer) {clock.clearTimeout(value.timer);value.timer = null;}
      if (!value.queued) {value.queued = true;queueMicrotask(() => flush(value));}
    } else if (!value.timer && !value.queued)
      value.timer = clock.setTimeout(() => {value.timer = null;flush(value);}, Math.max(0, THROTTLE_MS - (clock.now() - value.sentAt)));
  }
  function stopConfirmation(value) {
    if (value.deadline) {clock.clearTimeout(value.deadline.timer);value.deadline = null;}
    if (value.probe) {clock.clearTimeout(value.probe);value.probe = null;}
    value.confirmation = null;value.nativePreparing = false;
  }
  function confirmByDeadline(value) {
    const confirmation = value.confirmation;
    if (value.deadline) clock.clearTimeout(value.deadline.timer);
    value.deadline = {seq: confirmation.seq, timer: clock.setTimeout(() => {
      value.deadline = null;
      if (value.confirmation !== confirmation || value.desiredSeq !== confirmation.seq || value.phase !== "published") return;
      try {
        const progress = confirmation.progress?.();
        if (progress) owner.native(value.gamePath, confirmation.seq, progress);
      } catch (error) { warn("Graphics preparation status could not be read.", error); }
      if (value.phase !== "published" || value.confirmation !== confirmation || confirmation.until > clock.now()) return;
      if (value.probe) {clock.clearTimeout(value.probe);value.probe = null;}
      // An accepted revision whose row outcomes are still being observed
      // applies with what is known instead of reporting Not confirmed.
      const held = value.held;
      if (held?.documentRevision === confirmation.documentRevision) {acknowledge(value, held);return;}
      if (value.nativePreparing) {
        value.retained = value.acknowledged ? {documentRevision: value.acknowledged.documentRevision} : undefined;
      } else {
        let detail;
        try { detail = confirmation.explain?.(); } catch (error) { warn("Graphics acknowledgement could not be read.", error); }
        value.phase = "unconfirmed";value.reason = clean(detail, REASONS.unconfirmed);
      }
      notify(value);
    }, Math.max(0, confirmation.until - clock.now()))};
  }
  const current = (value, seq) => seq === undefined || seq === value.desiredSeq;
  const needs = (plan, wait) => Boolean(plan && plan.enabled !== false && wait.rows.some(row =>
    plan.video?.some(node => node.id === row.id && node.enabled === true && rowKey(node) === row.selectionKey)));
  // Rows that wait (pending) or were bypassed while the rest runs.
  function pendingReasons(value) {
    return [...new Set(Object.values(value.rows).filter(row => ["pending", "bypassed"].includes(row.state) && row.reason).map(row => row.reason))].join(" ") || undefined;
  }
  // Rows native code reports as not running for the accepted revision
  // (bypassed, failed or still preparing with a reason, beyond a brief
  // transient). Each is bypassed, or pending while it prepares, with that
  // reason and never counts as active. A row that runs again returns to
  // active with the next report.
  function observedRows(value, rows) {
    const outcomes = value.outcomes;value.outcomeIds = new Set();
    if (!outcomes || outcomes.documentRevision !== value.acknowledged?.documentRevision) return rows;
    for (const [id, row] of Object.entries(outcomes.rows)) if (rows[id]?.state === "active") {rows[id] = {...row};value.outcomeIds.add(id);}
    return rows;
  }
  function settledRows(value, ack) {
    const rows = {}, enabled = value.plan?.enabled !== false;
    for (const node of value.plan?.video || []) rows[node.id] = {state: enabled && node.enabled && ack?.state !== "bypass" ? "active" : "off"};
    for (const [id, row] of Object.entries(value.rows)) if (!value.outcomeIds?.has(id) && ["pending", "retained", "failed", "bypassed"].includes(row.state)) rows[id] = row;
    for (const [id, row] of Object.entries(ack?.rows || {})) rows[id] = {...row};
    return observedRows(value, rows);
  }
  // A report replaces the previous one for its revision.
  function report(value, documentRevision, outcomes) {
    if (!outcomes || typeof outcomes !== "object" || Array.isArray(outcomes)) return false;
    const rows = {};
    for (const [id, row] of Object.entries(outcomes)) if (typeof row?.reason === "string" && row.reason)
      rows[id] = {state: row.state === "pending" ? "pending" : "bypassed", reason: clean(row.reason)};
    value.outcomes = {documentRevision, rows};return true;
  }
  // Applied or partly applied, from the rows that are still pending.
  function settle(value) {
    if (!["applied", "partial"].includes(value.phase)) return;
    const reason = pendingReasons(value);
    value.phase = reason ? "partial" : "applied";value.reason = reason;
  }
  // What a status event shows, without acknowledgement times: a repeated
  // acknowledgement that changes nothing else sends no event.
  const shown = value => JSON.stringify(snapshot(value), (key, item) => key === "at" ? undefined : item);
  function acknowledge(value, ack) {
    if (!ack || typeof ack.documentRevision !== "string" || ack.launchId && value.launchId && ack.launchId !== value.launchId) return;
    const before = shown(value), reported = report(value, ack.documentRevision, ack.outcomes);
    value.acknowledged = {documentRevision: ack.documentRevision, ...(ack.controlsDigest ? {controlsDigest: ack.controlsDigest} : {}),
      state: ack.state === "bypass" ? "bypass" : "processing", at: clock.now()};
    const published = value.published, latest = published?.desiredSeq === value.desiredSeq;
    if (ack.rejected && published && ack.rejected.documentRevision === published.documentRevision && latest && ["published", "unconfirmed"].includes(value.phase)) {
      stopConfirmation(value);
      value.phase = "rejected";value.reason = clean(ack.rejected.reason, REASONS.rejected);
      value.retained = ack.documentRevision !== published.documentRevision ? {documentRevision: ack.documentRevision} : undefined;
    } else if (published && ack.documentRevision === published.documentRevision &&
        (!ack.controlsDigest || !published.controlsDigest || ack.controlsDigest === published.controlsDigest)) {
      if (latest && ["published", "unconfirmed"].includes(value.phase)) {
        stopConfirmation(value);value.rows = settledRows(value, ack);value.retained = undefined;value.phase = "applied";settle(value);
      } else if (latest && reported && ["applied", "partial"].includes(value.phase)) {value.rows = settledRows(value, value.acknowledged);settle(value);}
    } else if (["published", "unconfirmed"].includes(value.phase)) value.retained = {documentRevision: ack.documentRevision};
    if (shown(value) !== before) notify(value);
  }
  function probe(value, step = 0) {
    value.probe = clock.setTimeout(() => {
      value.probe = null;
      let ack;
      try { ack = value.reader?.(); } catch (error) { warn("Graphics acknowledgement could not be read.", error); }
      if (ack) acknowledge(value, ack);
      if (value.phase === "published" && value.deadline && value.reader) probe(value, step + 1);
    }, PROBES[Math.min(step, PROBES.length - 1)]);
  }

  // Model acquisition shared by every game that needs the same source.
  const jobKey = descriptor => descriptor.operation + "\0" + descriptor.source.version;
  function finish(value, wait, outcome, error) {
    if (value.waits.get(wait.key) !== wait) return;
    value.waits.delete(wait.key);
    const reason = outcome === "declined" ? REASONS.declined : outcome === "cancelled" ? REASONS.cancelled : outcome === "failed" ? clean(error?.message, REASONS.failed) : null;
    // A declined, cancelled or failed selection is not requested again until
    // its row changes, so unrelated edits never repeat the prompt.
    if (reason) for (const row of wait.rows) {value.blocked.set(row.id, {selectionKey: row.selectionKey, reason});value.rows[row.id] = {state: "pending", reason};}
    if (outcome === "installed") {
      if (!value.running) {
        if (wait.exited) {value.phase = "saved";value.reason = REASONS.readyNext;}
      } else if (needs(value.plan, wait)) {
        if (wait.usable && value.launchId === wait.launchId || value.launchId !== wait.launchId) {
          // The current desired plan finds the installed model in preparation.
          value.phase = "preparing";value.reason = undefined;
          try { resume(value.gamePath); } catch (failure) { warn("Graphics preparation could not resume.", failure); }
        } else for (const row of wait.rows) value.rows[row.id] = {state: "pending", reason: REASONS.readyNext};
      }
    }
    settle(value);notify(value, true);
  }
  function detach(value, key, why) {
    const wait = value.waits.get(key), job = jobs.get(key);
    if (!wait) return;
    if (why === "cancelled") finish(value, wait, "cancelled");else value.waits.delete(key);
    if (!job) return;
    job.waiters.delete(value);
    // Consent never outlives its last requester. A consented download is a
    // persistent managed model and continues when its game exits.
    if (job.owned && !job.waiters.size && (job.state === "consent" || why !== "exit"))
      job.controller.abort(Object.assign(new Error("The model download is no longer needed."), {name: "AbortError", code: "GRAPHICS_ACQUISITION_SUPERSEDED"}));
  }
  function run(job) {
    const signal = job.controller.signal, descriptor = {operation: job.operation, source: job.source};
    job.done = (async () => {
      try {
        if (job.state === "consent") {
          const gamePaths = [...job.waiters].map(value => value.gamePath);
          const approved = await models.consent({...descriptor, gamePaths, rows: [...job.waiters].flatMap(value => value.waits.get(job.key)?.rows || []), signal});
          signal.throwIfAborted();
          if (approved !== true && approved?.approved !== true) return {outcome: "declined"};
          job.state = "downloading";
          for (const value of job.waiters) notify(value, true);
        }
        const installed = await models.download({...descriptor, signal, onProgress: progress => {
          if (Number.isFinite(progress?.total) && progress.total > 0) job.bytes = progress.total;
          if (Number.isFinite(progress?.downloaded)) job.received = Math.min(progress.downloaded, job.bytes || progress.downloaded);
          if (progress?.state === "installing" || job.bytes > 0 && job.received >= job.bytes) job.state = "installing";
          // Download progress reaches the status UI at most four times a second.
          if (clock.now() - job.progressAt < PROGRESS_MS) return;
          job.progressAt = clock.now();
          for (const value of job.waiters) notify(value, false);
        }});
        signal.throwIfAborted();
        return installed ? {outcome: "installed"} : {outcome: "failed"};
      } catch (error) {
        if (signal.aborted || error?.name === "AbortError") return {outcome: "cancelled"};
        return {outcome: "failed", error};
      }
    })().then(({outcome, error}) => {
      jobs.delete(job.key);
      for (const value of [...job.waiters]) {const wait = value.waits.get(job.key);if (wait) finish(value, wait, outcome, error);}
    });
  }
  function acquire(value, seq, descriptor) {
    const key = jobKey(descriptor), rows = (descriptor.rows || []).map(row => ({id: row.id, selectionKey: row.selectionKey}));
    const existing = value.waits.get(key);
    if (existing) {Object.assign(existing, {rows, usable: descriptor.usable !== false, seq});return;}
    if (rows.length && rows.every(row => value.blocked.get(row.id)?.selectionKey === row.selectionKey)) {
      for (const row of rows) value.rows[row.id] = {state: "pending", reason: value.blocked.get(row.id).reason};
      return;
    }
    const wait = {key, rows, usable: descriptor.usable !== false, launchId: value.launchId, seq, exited: false};
    value.waits.set(key, wait);
    if (models.installed?.(descriptor) === true) {finish(value, wait, "installed");return;}
    let job = jobs.get(key);
    if (!job) {
      // An explicit Download elsewhere already authorized this source.
      const joined = models.active?.(descriptor) === true;
      job = {key, operation: descriptor.operation, source: {...descriptor.source}, state: joined ? "downloading" : "consent", owned: !joined,
        bytes: Number.isFinite(descriptor.source.bytes) ? descriptor.source.bytes : 0, received: 0, progressAt: -Infinity,
        controller: new AbortController(), waiters: new Set([value])};
      jobs.set(key, job);run(job);
    } else job.waiters.add(value);
  }

  const owner = {
    REASONS,
    status: gamePath => snapshot(records.get(gamePath) || blank(gamePath)),
    isCurrent: (gamePath, seq) => (records.get(gamePath)?.desiredSeq ?? 0) === seq,
    // E1: a persisted desired plan (or a stored plan adopted for display).
    desired(gamePath, {revision, plan = null, planSource = "effects", error, running, live, launchId, pid, extra} = {}) {
      const value = record(gamePath), seq = ++value.desiredSeq;
      stopConfirmation(value);
      if (running !== undefined) value.running = running === true;
      if (live !== undefined) value.live = live === true;
      if (launchId !== undefined) value.launchId = launchId || undefined;
      if (pid !== undefined) value.pid = pid || undefined;
      value.desiredRevision = revision;value.planSource = planSource;value.extra = {...extra};
      if (plan !== value.plan) {value.plan = plan;value.planChanged = Boolean(plan);}
      for (const [id, blocked] of value.blocked) {
        const node = plan?.video?.find(row => row.id === id);
        if (!node || !node.enabled || rowKey(node) !== blocked.selectionKey) value.blocked.delete(id);
      }
      for (const [key, wait] of [...value.waits]) if (!needs(plan, wait)) detach(value, key, "superseded");
      value.rows = {};value.retained = undefined;
      if (planSource === "invalid") {value.phase = "invalid";value.reason = clean(error?.message, "The saved graphics settings cannot be read.");}
      else if (!value.running) {value.phase = "saved";value.reason = undefined;}
      else if (!value.live) {value.phase = "deferred";value.reason = REASONS.unbound;}
      else {value.phase = "preparing";value.reason = undefined;}
      notify(value);
      return seq;
    },
    // The stored plan read for display, with no desired change or publication:
    // a game opened before any edit in this session. Publication state stays.
    adopt(gamePath, {revision, plan = null, running, live, launchId, pid} = {}) {
      const existing = records.get(gamePath);
      if (existing?.planSource === "effects") return snapshot(existing);
      const value = record(gamePath);
      if (running !== undefined) value.running = running === true;
      if (live !== undefined) value.live = live === true;
      if (launchId !== undefined) value.launchId = launchId || undefined;
      if (pid !== undefined) value.pid = pid || undefined;
      Object.assign(value, {desiredRevision: revision, planSource: "effects"});
      if (plan !== value.plan) {value.plan = plan;value.planChanged = Boolean(plan);}
      if (value.phase === "invalid") {value.phase = "saved";value.reason = undefined;}
      notify(value);
      return snapshot(value);
    },
    // E2: preparation of the remaining rows, plus pending model acquisitions.
    // A skipped row was bypassed with its reason while the other rows run.
    prepared(gamePath, seq, {pending = [], skipped = [], acquisitions = []} = {}) {
      const value = records.get(gamePath);if (!value || !current(value, seq)) return;
      // Each preparation attempt reports the complete set of pending rows.
      value.rows = {};value.outcomeIds = undefined;
      for (const row of skipped) if (typeof row?.id === "string")
        value.rows[row.id] = {state: "bypassed", ...(row.reason ? {reason: clean(row.reason)} : {})};
      for (const row of pending) if (typeof row?.id === "string")
        value.rows[row.id] = {state: row.retained === true ? "retained" : "pending", ...(row.reason ? {reason: clean(row.reason)} : {})};
      if (value.running) for (const descriptor of acquisitions) if (descriptor?.operation && descriptor.source?.version) acquire(value, seq, descriptor);
      notify(value);
    },
    // E3: committed, with the source allocation confirmed.
    // `explain` returns the native reason for a publication that is not
    // acknowledged by its deadline, when one exists.
    published(gamePath, seq, {documentRevision, controlsDigest, slow = false, committedAt, read, explain, progress} = {}) {
      const value = records.get(gamePath);if (!value || !current(value, seq) || typeof documentRevision !== "string") return;
      // One revision settles once. Publishing the same revision again for the
      // same desired plan (a resumed or repeated publication) never moves its
      // outcome back to published, so no later timer can downgrade an applied
      // status or restart an expired window; a late acknowledgement still
      // applies an unconfirmed one. A new preparation (rollback, installed
      // model) passes through preparing first and publishes normally.
      if (value.published?.desiredSeq === seq && value.published.documentRevision === documentRevision &&
          (value.published.controlsDigest || "") === (controlsDigest || "") && ["applied", "partial", "rejected", "unconfirmed"].includes(value.phase)) {
        const before = shown(value);
        if (value.phase === "applied" || value.phase === "partial") {value.rows = settledRows(value, value.acknowledged);settle(value);}
        if (value.dirty || shown(value) !== before) notify(value);
        return;
      }
      const previous = value.confirmation;
      stopConfirmation(value);
      value.published = {desiredSeq: seq, documentRevision, ...(controlsDigest ? {controlsDigest} : {}), at: clock.now()};
      value.reason = undefined;
      // A graph without processing, Off included, is acknowledged like any other.
      value.phase = "published";
      const ack = value.acknowledged;
      if (ack && Number.isFinite(committedAt) && ack.at >= committedAt && ack.documentRevision === documentRevision) {acknowledge(value, ack);return;}
      value.reader = value.watcher ? null : typeof read === "function" ? read : null;
      value.confirmation = previous?.seq === seq && previous.documentRevision === documentRevision ? previous : {
        seq, documentRevision, startedAt: Math.min(clock.now(), Number.isFinite(committedAt) ? committedAt : clock.now()),
        until: clock.now() + (slow ? SLOW_CONFIRM_MS : CONFIRM_MS)};
      value.confirmation.explain = typeof explain === "function" ? explain : null;
      value.confirmation.progress = typeof progress === "function" ? progress : null;
      confirmByDeadline(value);
      if (value.reader) probe(value);
      notify(value);
    },
    // A fresh report for this publication may still be preparing; acceptance
    // remains separate. Repeated reports cannot restart the 120 s bound.
    native(gamePath, seq, state) {
      const value = records.get(gamePath), confirmation = value?.confirmation;
      if (!value || !confirmation || !current(value, seq) || !["published", "unconfirmed"].includes(value.phase) ||
          confirmation.seq !== seq || state?.documentRevision !== confirmation.documentRevision ||
          state.launchId && value.launchId && state.launchId !== value.launchId ||
          !Number.isFinite(state.observedAt) || state.observedAt < confirmation.startedAt - 1000 ||
          state.observedAt > clock.now() + 1000 || clock.now() - state.observedAt > 6000) return;
      if (state.phase === "failed") {
        stopConfirmation(value);value.phase = "rejected";value.reason = clean(state.reason, REASONS.rejected);
        value.retained = value.acknowledged && value.acknowledged.documentRevision !== confirmation.documentRevision
          ? {documentRevision: value.acknowledged.documentRevision} : undefined;
        notify(value);return;
      }
      if (state.phase !== "preparing") return;
      // The confirmation window controls observation urgency, not validity.
      // A late preparation stays eligible for its actual acceptance or error.
      const first = !value.nativePreparing, reason = clean(state.reason);
      const changed = first || reason !== value.reason;
      value.phase = "published";value.nativePreparing = true;value.reason = reason || undefined;
      if (first) {
        confirmation.until = confirmation.startedAt + PREPARING_CONFIRM_MS;
        if (confirmation.until > clock.now()) confirmByDeadline(value);
      }
      if (changed) notify(value);
    },
    // E4: a publication was rolled back, or the next source path is tried.
    // One attempt chain is one publication; the phase never flips back. A
    // rollback restores the files published before the chain (`restored`,
    // null when there were none); they keep running.
    rolledBack(gamePath, seq, {restoredRevision, restored} = {}) {
      const value = records.get(gamePath);if (!value || !current(value, seq)) return;
      if (restoredRevision && value.published) value.published = {...value.published, documentRevision: restoredRevision};
      else if (restored !== undefined) value.published = restored ? {...restored} : undefined;
      if (value.phase !== "preparing") {value.phase = "preparing";value.reason = undefined;notify(value);}
    },
    retrying(gamePath, seq) { this.rolledBack(gamePath, seq); },
    // E5
    deferred(gamePath, seq, reason) {
      const value = records.get(gamePath);if (!value || !current(value, seq)) return;
      stopConfirmation(value);value.phase = "deferred";value.reason = clean(reason, REASONS.unbound);notify(value);
    },
    // E6
    rejected(gamePath, seq, reason) {
      const value = records.get(gamePath);if (!value || !current(value, seq)) return;
      stopConfirmation(value);value.phase = "rejected";value.reason = clean(reason, REASONS.rejected);
      value.retained = value.acknowledged ? {documentRevision: value.acknowledged.documentRevision} : undefined;notify(value);
    },
    // E7: a native acknowledgement, or an acceptance observed by a status read.
    // `outcomes` lists the rows native code reports as not running.
    ack(gamePath, ack) { const value = records.get(gamePath);if (value?.running) acknowledge(value, ack); },
    // An accepted revision whose row outcomes main still observes: the
    // acknowledgement known so far, applied if the confirmation deadline
    // comes first. Without `ack`, it ends that observation.
    holding(gamePath, documentRevision, ack) {
      const value = records.get(gamePath);if (!value) return;
      if (ack?.documentRevision === documentRevision) value.held = ack;
      else if (value.held?.documentRevision === documentRevision) value.held = undefined;
    },
    // Row outcomes for the accepted revision from a later status read: a row
    // that stops running (D9) moves an applied record to partial, and back.
    observed(gamePath, {documentRevision, launchId, outcomes} = {}) {
      const value = records.get(gamePath);
      if (!value?.running || !value.acknowledged || documentRevision !== value.acknowledged.documentRevision ||
          launchId && value.launchId && launchId !== value.launchId) return;
      const before = shown(value);
      if (!report(value, documentRevision, outcomes)) return;
      if (["applied", "partial"].includes(value.phase) && value.published?.documentRevision === documentRevision) {
        value.rows = settledRows(value, value.acknowledged);settle(value);
      }
      if (shown(value) !== before) notify(value);
    },
    // E9: a running process with its launch binding.
    bound(gamePath, {launchId, pid, live = false, watch, documentRevision} = {}) {
      const value = record(gamePath);
      if (value.watcher) {try { value.watcher(); } catch {}value.watcher = null;}
      Object.assign(value, {running: true, live: live === true, launchId: launchId || undefined, pid: pid || undefined, acknowledged: undefined, retained: undefined,
        outcomes: undefined});
      if (typeof documentRevision === "string") value.published = {desiredSeq: value.desiredSeq, documentRevision, at: clock.now()};
      if (value.phase === "saved") value.reason = undefined;
      if (typeof watch === "function") try { value.watcher = watch(ack => acknowledge(value, ack)) || null; }
      catch (error) { value.watcher = null;warn("Graphics acknowledgements are unavailable for this launch.", error); }
      notify(value);
    },
    // E10
    ended(gamePath, {launchId} = {}) {
      const value = records.get(gamePath);if (!value || launchId && value.launchId && launchId !== value.launchId) return;
      stopConfirmation(value);
      if (value.watcher) {try { value.watcher(); } catch {}value.watcher = null;}
      const interrupted = ["preparing", "published", "unconfirmed"].includes(value.phase) || value.running && active(value).length > 0;
      let downloading = false;
      for (const [key, wait] of [...value.waits]) {
        if (jobs.get(key)?.state === "consent") detach(value, key, "exit");
        else {wait.exited = true;downloading = true;}
      }
      // Keep a known failure until a new edit or launch supplies new facts.
      const reason = value.planSource === "invalid" || ["saved", "deferred", "rejected"].includes(value.phase) ? value.reason : downloading ? REASONS.downloadingNext : interrupted ? REASONS.stopped : undefined;
      Object.assign(value, {running: false, live: false, launchId: undefined, pid: undefined, published: undefined, acknowledged: undefined,
        retained: undefined, reader: null, reason, rows: {}, outcomes: undefined, outcomeIds: undefined, held: undefined});
      if (value.planSource !== "invalid") value.phase = "saved";
      notify(value, true);
    },
    // E13
    invalid(gamePath, error) { return this.desired(gamePath, {planSource: "invalid", error}); },
    // User Cancel in the status UI.
    cancel(gamePath) {
      const value = records.get(gamePath);if (!value) return false;
      const keys = [...value.waits.keys()];
      for (const key of keys) detach(value, key, "cancelled");
      return keys.length > 0;
    },
    forget(gamePath) {
      const value = records.get(gamePath);if (!value) return;
      stopConfirmation(value);if (value.timer) clock.clearTimeout(value.timer);
      if (value.watcher) try { value.watcher(); } catch {}
      for (const key of [...value.waits.keys()]) detach(value, key, "superseded");
      records.delete(gamePath);
    },
    dispose() {
      for (const gamePath of [...records.keys()]) {
        const value = records.get(gamePath);stopConfirmation(value);if (value.timer) clock.clearTimeout(value.timer);
        if (value.watcher) try { value.watcher(); } catch {}
        for (const key of [...value.waits.keys()]) if (jobs.get(key)?.state === "consent") detach(value, key, "exit");
      }
      records.clear();
    },
    // Acquisition jobs still waiting or downloading (tests and diagnostics).
    acquisitions: () => [...jobs.values()].map(job => ({id: job.key, operation: job.operation, state: job.state, owned: job.owned,
      waiters: [...job.waiters].map(value => value.gamePath)}))
  };
  return owner;
}

module.exports = {createGraphicsStatusOwner, REASONS, THROTTLE_MS, CONFIRM_MS, SLOW_CONFIRM_MS, PREPARING_CONFIRM_MS};
