/*
 * athenaMessaging.js
 *
 * Messaging bridge between this embedded web app and athenahealth's athenaOne.
 *
 * Responsibilities:
 *   - Listen for the inbound `patientContextChanged` postMessage from athenaOne,
 *     validating the message origin against *.athenahealth.com.
 *   - Send outbound postMessages back to athenaOne using the embedded app API
 *     envelope: { type: 'embeddedAppAPIMessage', methodVersion: '1.0.0', ... }.
 *   - Provide a demo mode that simulates a patientContextChanged event when the
 *     app runs outside of athenaOne, so the UI can be tested locally.
 *
 * Exposed as window.AthenaMessaging. No external dependencies; no inline script
 * (the app's CSP is `default-src 'self' *.athenahealth.com`).
 */
(function () {
  'use strict';

  var MESSAGE_TYPE = 'embeddedAppAPIMessage';
  var METHOD_VERSION = '1.0.0';
  var INBOUND_PATIENT_CONTEXT = 'patientContextChanged';
  // athenaOne's state receipt for an honored outbound window op. Observed live
  // 2026-09-23 (Craig, Preview) right after the boot appResize(600) visibly
  // applied; full shape confirmed 2026-09-29: { event: 'appStateChanged',
  // action: 'Resized', newState: { isAppVisible, location (e.g. 'modal'),
  // position: { x, y, height, width } } }. It is the first positive delivery receipt we
  // have — an outbound op that athenaOne acts on produces one of these; one
  // that produces none was ignored (or changed nothing, e.g. appPopin while
  // already popped in).
  var INBOUND_APP_STATE = 'appStateChanged';

  // Allowed inbound/outbound athenaOne origins: any *.athenahealth.com over https.
  // Requires at least one subdomain label — the apex `athenahealth.com` is NOT
  // accepted (matches the `*.athenahealth.com` boundary exactly).
  var ALLOWED_ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)+athenahealth\.com$/i;

  // Valid widths for appResize, per athenaOne's embedded app API.
  var RESIZE_WIDTHS = [100, 200, 400, 600, 800, 1000];

  // Compound athena patient-context id — the same format as the token
  // response's `patient` claim: a-{practiceId}.E-{patientId}
  // (e.g. a-1959370.E-27075). Whether patientContextChanged carries this
  // compound form or a bare patient id is unconfirmed until a real broadcast
  // arrives (the capture buffer records the wire format verbatim); both are
  // accepted so same-patient equality holds against the launch path, which
  // stores the BARE id parsed from the token claim.
  var COMPOUND_PATIENT_RE = /^a-(\d+)\.E-(\d+)$/i;

  var state = {
    athenaOrigin: null, // captured from the first valid inbound message
    // Configured athenaOne origin (init option, threaded from the server's
    // environment config). Needed because document.referrer is EMPTY in the
    // real embed — athena's Okta-backed authorize hop strips it — so the
    // referrer fallback never fires there (observed live 2026-07-28).
    configuredOrigin: null,
    demoMode: false,
    handlers: [],
    appStateHandlers: [],
    initialized: false,
    lastPracticeId: null, // 28C: carried into message-delivered contexts
  };

  // --- 27C-DEBUG: raw message capture -----------------------------------------
  // The bridge used to SILENTLY drop messages failing its origin/shape checks —
  // fatal for diagnosing whether athenaOne sent a (differently-shaped)
  // navigation message or nothing at all. Every window `message` event is now
  // recorded verbatim into a ring buffer, tagged with the bridge's verdict.
  // The verdict is RE-DERIVED here by running the exact same checks
  // handleWindowMessage runs (deterministic — no cross-handler bookkeeping to
  // drift out of sync). Capture is registered at script evaluation, BEFORE and
  // independent of init(), so even pre-init messages are recorded.
  var CAPTURE_CAP = 50;
  var capturedMessages = [];
  var captureSubscribers = [];

  function safeDataPreview(data) {
    var s;
    try {
      s = JSON.stringify(data);
      if (typeof s !== 'string') s = String(data);
    } catch (e) {
      s = String(data);
    }
    if (s.length > 400) s = s.slice(0, 400) + '\u2026';
    return s;
  }

  // 28C: athena's DOCUMENTED outbound shape (Embedded App Messaging
  // Framework): { event: 'patientContextChanged', updatedPatient } where
  // updatedPatient is a patientId string OR undefined (context cleared —
  // e.g. the user is on a non-patient page). ONE shared helper used by BOTH
  // deriveVerdict (acceptance) and normalizeContext (mapping) so a message
  // is never accepted under one interpretation and normalized under another
  // (architect finding). Mixed-key messages — documented keys PLUS an
  // internal-envelope kind key — are deliberately NOT documented-shape:
  // deriveVerdict falls through to unrecognized-shape unless the envelope
  // kind itself matches.
  function isDocumentedPatientContextShape(data) {
    return (
      data.event === INBOUND_PATIENT_CONTEXT &&
      (typeof data.updatedPatient === 'string' || typeof data.updatedPatient === 'undefined') &&
      !(data.messageType || data.type || data.method)
    );
  }

  function deriveVerdict(event) {
    if (!isAllowedOrigin(event.origin)) return 'rejected-origin';
    var data = event.data;
    if (!data || typeof data !== 'object') return 'unrecognized-shape';
    var kind = data.messageType || data.type || data.method;
    if (kind === INBOUND_PATIENT_CONTEXT) return 'accepted';
    // 28C: the documented dialect — this is still the ONE shared predicate
    // (27C invariant); the capture tagging and the bridge acceptance both
    // run through deriveVerdict.
    if (isDocumentedPatientContextShape(data)) return 'accepted';
    // Same documented-dialect rule as patientContextChanged: an internal
    // envelope kind key disqualifies it.
    if (data.event === INBOUND_APP_STATE && !(data.messageType || data.type || data.method)) return 'app-state';
    return 'unrecognized-shape';
  }

  function recordCapture(entry) {
    capturedMessages.push(entry);
    if (capturedMessages.length > CAPTURE_CAP) {
      capturedMessages.splice(0, capturedMessages.length - CAPTURE_CAP);
    }
    captureSubscribers.forEach(function (fn) {
      try { fn(entry); } catch (e) {
        console.error('[athenaMessaging] capture subscriber error', e);
      }
    });
  }

  function captureWindowMessage(event) {
    recordCapture({
      ts: Date.now(),
      origin: String(event.origin || ''),
      dataPreview: safeDataPreview(event.data),
      verdict: deriveVerdict(event),
    });
  }
  window.addEventListener('message', captureWindowMessage, false);

  function isAllowedOrigin(origin) {
    return typeof origin === 'string' && ALLOWED_ORIGIN_RE.test(origin);
  }

  function originOf(url) {
    try {
      return new URL(url).origin;
    } catch (e) {
      return '';
    }
  }

  function outboundTargetOrigin() {
    // Prefer the exact athenaOne origin we received a message from; fall back to
    // the document referrer's origin if it's a valid athenahealth origin.
    if (state.athenaOrigin) return state.athenaOrigin;
    // Environment-configured athenaOne origin (already allowlist-validated at
    // init) — the docs' prescribed target ("Set appropriately for the
    // environment you are in"), and the only reliable source in the real
    // embed, where the referrer is stripped by the authorize hop.
    if (state.configuredOrigin) return state.configuredOrigin;
    var refOrigin = originOf(document.referrer || '');
    if (isAllowedOrigin(refOrigin)) return refOrigin;
    // '*' is acceptable ONLY when the page is its own parent (unframed demo:
    // the postMessage goes to the page itself). When actually framed —
    // including the SMART url-boot path, which runs with demoMode on — a
    // missing validated origin means there is NO safe target: outbound
    // payloads carry patient ids and must never be broadcast to an
    // unverified parent with a wildcard target (e.g. when a referrer policy
    // strips the athenaOne referrer before any inbound message arrives).
    if (state.demoMode && window.self === window.top) return '*';
    return null;
  }

  function send(method, payload) {
    var message = { type: MESSAGE_TYPE, methodVersion: METHOD_VERSION, method: method };
    if (payload && typeof payload === 'object') {
      for (var key in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) {
          message[key] = payload[key];
        }
      }
    }

    var target = outboundTargetOrigin();
    if (!target) {
      // No validated athenaOne origin (and not an unframed demo): nowhere safe to post.
      console.warn('[athenaMessaging] no athenaOne target origin; outbound "' + method + '" not sent');
      return message;
    }

    try {
      window.parent.postMessage(message, target);
    } catch (e) {
      console.error('[athenaMessaging] failed to post message', e);
    }

    if (state.demoMode) {
      console.info('[athenaMessaging] (demo) outbound →', method, message, 'target:', target);
    }
    return message;
  }

  // ---- Outbound API methods (all use the embeddedAppAPIMessage v1.0.0 envelope) ----
  var api = {
    MESSAGE_TYPE: MESSAGE_TYPE,
    METHOD_VERSION: METHOD_VERSION,
    RESIZE_WIDTHS: RESIZE_WIDTHS.slice(),

    notifyPatientDataChange: function (detail) {
      // WIRE SHAPE CORRECTED 2026-08-12 — docs-exact: the guide lists this
      // method's Parameters as **None**, and this previously sent an invented
      // `detail` key on the wire. The one outbound method PROVEN working live
      // (appResize, visibly applies) carries only documented parameters
      // (NB 2026-09-18: "since origin registration" struck — athena says the
      // app was never registered for postmessaging; outbound delivery is
      // browser-level and never depended on it); this one — observed NOT triggering athenaOne's
      // main-frame reload, Craig 2026-08-12 — carried an undocumented one.
      // This framework's failure mode is the SILENT DROP (wrong origin,
      // malformed message: no error, nothing happens), so a strictly-validated
      // handler discarding the extra key fits the symptom exactly. The caller's
      // context object stays useful locally (log + harness interception at this
      // API layer) but never reaches the wire.
      if (detail) {
        console.info('[athenaMessaging] notifyPatientDataChange context (local only, not sent)', detail);
      }
      return send('notifyPatientDataChange', null);
    },
    appMinimize: function () {
      return send('appMinimize', null);
    },
    appReopen: function () {
      return send('appReopen', null);
    },
    appEnterFullscreen: function () {
      return send('appEnterFullscreen', null);
    },
    appExitFullscreen: function () {
      return send('appExitFullscreen', null);
    },
    appClose: function () {
      return send('appClose', null);
    },
    appResize: function (newWidth) {
      // athena's docs list numeric widths but their own example passes a
      // string ('600') — accept both forms, validate the numeric value.
      var width = Number(newWidth);
      if (RESIZE_WIDTHS.indexOf(width) === -1) {
        throw new Error('appResize: newWidth must be one of ' + RESIZE_WIDTHS.join(', '));
      }
      return send('appResize', { newWidth: width });
    },
    appPopout: function () {
      return send('appPopout', null);
    },
    appPopin: function () {
      return send('appPopin', null);
    },
    appShowBadge: function (text) {
      return send('appShowBadge', text != null ? { text: String(text) } : null);
    },
    appShowBadgePersistent: function (text) {
      return send('appShowBadgePersistent', text != null ? { text: String(text) } : null);
    },
    appClearBadge: function () {
      return send('appClearBadge', null);
    },
  };

  // ---- Inbound patientContextChanged handling ----
  api.onPatientContextChanged = function (handler) {
    if (typeof handler === 'function') {
      state.handlers.push(handler);
    }
    return function unsubscribe() {
      var idx = state.handlers.indexOf(handler);
      if (idx >= 0) state.handlers.splice(idx, 1);
    };
  };

  // athenaOne appStateChanged receipts (see INBOUND_APP_STATE). Handlers get
  // the verbatim message data and { origin }.
  api.onAppStateChanged = function (handler) {
    if (typeof handler === 'function') {
      state.appStateHandlers.push(handler);
    }
    return function unsubscribe() {
      var idx = state.appStateHandlers.indexOf(handler);
      if (idx >= 0) state.appStateHandlers.splice(idx, 1);
    };
  };

  // 28D: ONE id-normalization chokepoint for every arrival path (url-boot
  // demoContext, documented athena shape, internal envelope, demo). All ids
  // leave normalizeContext as trimmed strings (or null), so the app's
  // same-patient equality never forks per path or misses on value type
  // (e.g. a numeric patientid in an internal envelope vs the string URL id).
  function normalizeId(value) {
    if (value === null || value === undefined) return null;
    var s = String(value).trim();
    return s === '' ? null : s;
  }

  function normalizeContext(data) {
    // 28C: athena's documented shape — { event: 'patientContextChanged',
    // updatedPatient: '<id>' | undefined }.
    //   - string  -> a patient change. The encounter is UNKNOWN after a
    //     patient change, so encounterId is ALWAYS null here — never carried
    //     over (wrong-encounter is the same hazard class as wrong-patient).
    //     practiceId is carried from the current/launch context (the message
    //     doesn't include it; the practice cannot change mid-session).
    //   - undefined -> a CONTEXT-CLEARED signal: patientId null.
    // raw.source = 'athena-message' so the app can render the real-ID-first
    // header for message-delivered contexts too (28B did the same for the
    // url-launch source).
    if (isDocumentedPatientContextShape(data)) {
      var updated = typeof data.updatedPatient === 'string' ? normalizeId(data.updatedPatient) : null;
      var practiceId = state.lastPracticeId || null;
      // Compound form: extract the bare patient id (so equality with the
      // launch-parsed id holds) and take the practiceId the message itself
      // carries in preference to the carried-over launch practice.
      var compound = updated ? COMPOUND_PATIENT_RE.exec(updated) : null;
      var patientId = compound ? compound[2] : updated;
      if (compound) practiceId = compound[1];
      return {
        patientId: patientId,
        encounterId: null,
        practiceId: practiceId,
        // raw.updatedPatient keeps the VERBATIM wire value (compound or bare)
        // so the debug panel tells the truth about what athena actually sent.
        raw: { source: 'athena-message', event: data.event, updatedPatient: updated },
      };
    }
    // Internal envelope — athenaOne casing can vary; accept the common variants.
    var patientId = normalizeId(data.patientID || data.patientId || data.patientid || null);
    var encounterId = normalizeId(data.encounterID || data.encounterId || data.encounterid || null);
    return { patientId: patientId, encounterId: encounterId, raw: data };
  }

  function emit(context, meta) {
    // 28C: remember the practice across contexts so a message-delivered
    // patient change (which carries no practiceId) stays in the same practice.
    var practiceId =
      (context && context.practiceId) ||
      (context && context.raw && context.raw.practiceId) ||
      null;
    if (practiceId) state.lastPracticeId = practiceId;
    state.handlers.forEach(function (handler) {
      try {
        handler(context, meta);
      } catch (e) {
        console.error('[athenaMessaging] patientContextChanged handler error', e);
      }
    });
  }

  function handleWindowMessage(event) {
    // 27C-DEBUG: verdict comes from the SAME predicate the capture listener
    // uses (deriveVerdict) — one source of truth, no drift possible — and no
    // more silent drops: every ignored message logs one line with the reason.
    // (The raw event is also in the capture buffer.)
    var verdict = deriveVerdict(event);
    if (verdict === 'app-state') {
      // A receipt, not a context change: it never touches patient context or
      // the outbound target origin.
      console.info('[athenaMessaging] inbound appStateChanged', event.data.action, event.data);
      state.appStateHandlers.forEach(function (handler) {
        try {
          handler(event.data, { origin: event.origin });
        } catch (e) {
          console.error('[athenaMessaging] appStateChanged handler error', e);
        }
      });
      return;
    }
    if (verdict !== 'accepted') {
      console.warn('[athenaMessaging] ignored message', { origin: event.origin, reason: verdict });
      return;
    }
    state.athenaOrigin = event.origin; // remember where to reply
    emit(normalizeContext(event.data), { origin: event.origin, demo: false });
  }

  // ---- Demo mode ----
  function isEmbeddedInAthena() {
    var framed = window.self !== window.top;
    var refOrigin = originOf(document.referrer || '');
    return framed && isAllowedOrigin(refOrigin);
  }

  function startDemoMode(options) {
    state.demoMode = true;
    var context = (options && options.demoContext) || { patientId: 'P-100242', encounterId: 'E-558843' };
    var delayMs = options && typeof options.demoDelayMs === 'number' ? options.demoDelayMs : 600;
    // 28B: when the context came from the server's SMART-launch handoff (the
    // boot threads source:'athena' through demoContext), the capture/emit
    // origin label is 'url-launch' — the debug panel must tell the truth about
    // where context came from. Everything else about the path is unchanged.
    var originLabel = context && context.source === 'athena' ? 'url-launch' : 'demo';
    console.info(
      '[athenaMessaging] demo mode active — simulating patientContextChanged for',
      context.patientId,
      'in',
      delayMs + 'ms',
    );
    setTimeout(function () {
      // 27C-DEBUG: the simulated event flows through the capture buffer too —
      // it is the positive control ("the panel shows accepted context
      // messages") when reading an otherwise-empty capture.
      recordCapture({
        ts: Date.now(),
        origin: originLabel,
        dataPreview: safeDataPreview({ messageType: INBOUND_PATIENT_CONTEXT, patientId: context.patientId, encounterId: context.encounterId }),
        verdict: 'accepted',
      });
      emit(normalizeContext(context), { origin: originLabel, demo: true });
    }, delayMs);
  }

  /**
   * Initialize the bridge.
   * @param {Object} [options]
   * @param {boolean} [options.demo] Force demo mode on/off. When omitted, demo
   *   mode auto-activates if the app is not embedded inside an athenahealth page.
   * @param {Object} [options.demoContext] { patientId, encounterId } to simulate.
   * @param {number} [options.demoDelayMs] Delay before the simulated event fires.
   */
  api.init = function (options) {
    options = options || {};
    if (state.initialized) return api;
    state.initialized = true;

    // Outbound target origin from configuration (server-threaded). Validated
    // against the SAME allowlist as inbound origins — a non-athenahealth
    // value is rejected, never used as a postMessage target.
    if (options.athenaOrigin) {
      if (isAllowedOrigin(options.athenaOrigin)) {
        state.configuredOrigin = options.athenaOrigin;
      } else {
        console.warn('[athenaMessaging] ignoring configured athenaOrigin (not an allowed athenahealth origin):', options.athenaOrigin);
      }
    }

    window.addEventListener('message', handleWindowMessage, false);

    var embedded = isEmbeddedInAthena();
    var useDemo = options.demo === true || (typeof options.demo === 'undefined' && !embedded);
    api.isDemoMode = useDemo;
    if (useDemo) {
      startDemoMode(options);
    }
    return api;
  };

  api.isDemoMode = false;

  // ---- 27C-DEBUG: capture buffer read access for the app's debug panel ----
  api.getCapturedMessages = function () {
    return capturedMessages.slice();
  };
  api.clearCapturedMessages = function () {
    capturedMessages.length = 0;
  };
  api.onMessageCaptured = function (fn) {
    if (typeof fn === 'function') captureSubscribers.push(fn);
    return function unsubscribe() {
      var idx = captureSubscribers.indexOf(fn);
      if (idx >= 0) captureSubscribers.splice(idx, 1);
    };
  };

  window.AthenaMessaging = api;
})();
