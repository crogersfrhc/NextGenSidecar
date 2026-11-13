/*
 * NextGen Sidecar — PRD §13 experience states (demo switcher).
 *
 * Every state the user can land in has a message and a next step; none ends in
 * a blank window or a raw error. Copy is the PRD's starting copy, for UX review.
 *
 * Three kinds of state:
 *   - window:  replaces the whole Sidecar (e.g. Session expired, Account not linked)
 *   - banner:  shown above the tabs, patient view still usable (No findings,
 *              Findings to review, Locked encounter)
 *   - outcome: the result of a Post Data write (No permission, Required field
 *              missing, Likely duplicate, Write failed, Write uncertain)
 *
 * Demo only: the switcher sits in the demo panel. In a live build each state is
 * reached from the real launch / read / write result, not from this menu.
 * All styling is via classes in styles.css (the embed CSP blocks inline styles).
 */
(function () {
  'use strict';

  var STATES = [
    { key: 'profile', label: 'Patient view (default)', kind: 'none' },
    { key: 'loading', label: 'Loading', kind: 'window', icon: '',
      title: 'Loading Olivia Torres…', body: 'Getting the patient from NextGen and FrontRunner.', next: null, spinner: true },
    { key: 'no-findings', label: 'No findings', kind: 'banner', tone: 'ok',
      title: 'Everything we checked matches NextGen', body: 'Last checked 11/13/2026 2:41 PM.', next: 'Re-run checks' },
    { key: 'findings', label: 'Findings to review', kind: 'banner', tone: 'warn',
      title: '4 differences from NextGen', body: 'Review them side by side, then approve one, approve all, or dismiss.', next: 'Review in Post Data', action: 'post' },
    { key: 'practice-not-connected', label: 'Practice not connected', kind: 'window', icon: '🔌',
      title: 'This practice isn’t connected to FrontRunner', body: 'Practice 001 has not authorized FrontRunner in NextGen.', next: 'Contact your practice’s NextGen administrator' },
    { key: 'not-enabled', label: 'FrontRunner not enabled', kind: 'window', icon: '⏸️',
      title: 'FrontRunner isn’t turned on for this practice', body: 'NextGen is turned off for this client in FrontRunner.', next: 'Contact FrontRunner support' },
    { key: 'no-permission', label: 'No permission (write)', kind: 'outcome', tone: 'bad',
      title: 'Your NextGen access doesn’t allow this change', body: 'NextGen refused the update to Primary Insurance. Nothing was saved.', next: 'Ask your practice’s NextGen administrator' },
    { key: 'required-field', label: 'Required field missing (write)', kind: 'outcome', tone: 'warn',
      title: 'Group number is required by this practice', body: 'Fill it in before posting Secondary Insurance, or cancel this change.', next: 'Fill the field', secondary: 'Cancel change', action: 'post' },
    { key: 'locked-encounter', label: 'Locked encounter', kind: 'banner', tone: 'warn',
      title: 'Encounter E-558843 is locked', body: 'Insurance changes can’t attach to this encounter. Demographic and person-level insurance changes can still be posted.', next: 'Continue with person-level changes', action: 'post' },
    { key: 'duplicate', label: 'Likely duplicate insurance (write)', kind: 'outcome', tone: 'warn',
      title: 'NextGen already has a matching coverage', body: 'Aetna Choice POS II · Member ID W2049913 (Secondary) looks like the coverage you are adding.', next: 'Update the existing coverage', secondary: 'Add as a second coverage' },
    { key: 'write-failed', label: 'Write failed', kind: 'outcome', tone: 'bad',
      title: 'NextGen didn’t save this change', body: 'Invalid Payor Priorities: two coverages can’t share the Secondary position.', next: 'Fix and retry', secondary: 'Dismiss', action: 'post' },
    { key: 'write-uncertain', label: 'Write uncertain', kind: 'outcome', tone: 'neutral',
      title: 'We couldn’t confirm this saved', body: 'Checking NextGen for Primary Insurance… Don’t post it again yet.', next: null, spinner: true },
    { key: 'session-expired', label: 'Session expired', kind: 'window', icon: '⏱️',
      title: 'Please reopen FrontRunner from the patient’s record', body: 'Your 60-minute session ended. Anything already posted to NextGen is saved.', next: 'Relaunch' },
    { key: 'unavailable', label: 'NextGen or FrontRunner unavailable', kind: 'window', icon: '⚠️',
      title: 'FrontRunner can’t reach NextGen right now', body: 'Try again in a few minutes.', next: 'Try again', secondary: 'Status page' },
    { key: 'not-linked', label: 'Account not linked', kind: 'pairing' },
  ];

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var current = 'profile';

  function clear() {
    ['ng-window', 'ng-banner', 'ng-outcome'].forEach(function (id) {
      var n = $(id);
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
    var profile = $('state-profile');
    if (profile) profile.hidden = false;
  }

  function actions(s, onPrimary) {
    var row = el('div', 'ng-actions');
    if (s.next) {
      var b = el('button', 'btn btn-primary', s.next);
      b.type = 'button';
      b.addEventListener('click', onPrimary);
      row.appendChild(b);
    }
    if (s.secondary) {
      var c = el('button', 'btn ng-btn-secondary', s.secondary);
      c.type = 'button';
      c.addEventListener('click', function () { apply('profile'); });
      row.appendChild(c);
    }
    return row;
  }

  function primaryHandler(s) {
    return function () {
      if (s.action === 'post') {
        clear();
        var btn = $('post-data-btn');
        if (btn) btn.click();
      } else if (s.key === 'session-expired' || s.key === 'unavailable' || s.key === 'no-findings') {
        apply('profile');
      }
    };
  }

  function renderWindow(s) {
    var profile = $('state-profile');
    if (profile) profile.hidden = true;
    var w = el('section', 'state-panel ng-window');
    w.id = 'ng-window';
    w.setAttribute('aria-live', 'polite');
    if (s.spinner) { var sp = el('div', 'spinner'); sp.setAttribute('aria-hidden', 'true'); w.appendChild(sp); }
    if (s.icon) { var ic = el('div', 'state-icon', s.icon); ic.setAttribute('aria-hidden', 'true'); w.appendChild(ic); }
    w.appendChild(el('h1', null, s.title));
    w.appendChild(el('p', 'muted', s.body));
    w.appendChild(actions(s, primaryHandler(s)));
    profile.parentNode.insertBefore(w, profile);
  }

  function renderBanner(s, id, kindLabel) {
    var profile = $('state-profile');
    var bar = $('tab-bar');
    var b = el('div', 'ng-banner ng-tone-' + (s.tone || 'neutral'));
    b.id = id;
    b.setAttribute('role', s.tone === 'bad' ? 'alert' : 'status');
    if (kindLabel) b.appendChild(el('div', 'ng-banner-kind', kindLabel));
    var head = el('div', 'ng-banner-title');
    if (s.spinner) { var sp = el('span', 'spinner ng-spinner-sm'); sp.setAttribute('aria-hidden', 'true'); head.appendChild(sp); }
    head.appendChild(document.createTextNode(s.title));
    b.appendChild(head);
    b.appendChild(el('div', 'ng-banner-body', s.body));
    b.appendChild(actions(s, primaryHandler(s)));
    profile.insertBefore(b, bar || profile.firstChild.nextSibling);
  }

  // Account not linked: email-code pairing (PRD §13 last row; SC-ACC).
  function renderPairing() {
    var profile = $('state-profile');
    if (profile) profile.hidden = true;
    var w = el('section', 'state-panel ng-window ng-pairing');
    w.id = 'ng-window';
    var ic = el('div', 'state-icon', '🔗'); ic.setAttribute('aria-hidden', 'true'); w.appendChild(ic);
    w.appendChild(el('h1', null, 'Account not paired'));
    w.appendChild(el('p', 'muted', 'Your NextGen user isn’t linked to a FrontRunner user yet. Enter the code we emailed you to link them. You only do this once.'));

    var form = el('form', 'ng-pair-form');
    var label = el('label', 'ng-pair-label', 'FrontRunner email');
    var email = el('input', 'ng-input');
    email.type = 'email'; email.placeholder = 'name@practice.com'; email.autocomplete = 'email';
    label.appendChild(email);
    var send = el('button', 'btn ng-btn-secondary', 'Email me a code'); send.type = 'button';
    var codeLabel = el('label', 'ng-pair-label', '6-digit code');
    var code = el('input', 'ng-input ng-code');
    code.inputMode = 'numeric'; code.maxLength = 6; code.placeholder = '123456'; code.autocomplete = 'one-time-code';
    codeLabel.appendChild(code);
    var verify = el('button', 'btn btn-primary', 'Verify code'); verify.type = 'submit';
    var msg = el('p', 'ng-pair-msg muted'); msg.setAttribute('aria-live', 'polite');

    send.addEventListener('click', function () {
      msg.textContent = email.value ? 'Code sent to ' + email.value + '. It expires in 10 minutes.' : 'Enter your FrontRunner email first.';
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (/^\d{6}$/.test(code.value)) {
        msg.textContent = 'Linked. Loading the patient…';
        setTimeout(function () { apply('profile'); }, 600);
      } else {
        msg.textContent = 'That code isn’t right. Check the email and try again. (Demo: any 6 digits.)';
      }
    });

    form.appendChild(label); form.appendChild(send);
    form.appendChild(codeLabel); form.appendChild(verify);
    w.appendChild(form);
    w.appendChild(msg);
    var help = el('p', 'muted ng-pair-help', 'No email? Contact FrontRunner support.');
    w.appendChild(help);
    profile.parentNode.insertBefore(w, profile);
  }

  function apply(key) {
    current = key;
    var sel = $('ng-state-select');
    if (sel && sel.value !== key) sel.value = key;
    clear();
    var s = STATES.filter(function (x) { return x.key === key; })[0];
    if (!s || s.kind === 'none') return;
    if (!$('state-profile') || $('state-profile').hidden && s.kind !== 'window' && s.kind !== 'pairing') {
      // Patient view not loaded yet; nothing to attach a banner to.
    }
    if (s.kind === 'window') renderWindow(s);
    else if (s.kind === 'pairing') renderPairing();
    else if (s.kind === 'banner') renderBanner(s, 'ng-banner', null);
    else if (s.kind === 'outcome') renderBanner(s, 'ng-outcome', 'Post Data result');
  }

  function init() {
    var sel = $('ng-state-select');
    if (!sel) return;
    STATES.forEach(function (s) {
      var o = el('option', null, s.label);
      o.value = s.key;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { apply(sel.value); });
    var reset = $('ng-state-reset');
    if (reset) reset.addEventListener('click', function () { apply('profile'); });
    // ?state=<key> deep-links a state (used by screenshots and reviews).
    var q = new URLSearchParams(window.location.search).get('state');
    if (q) {
      var tries = 0;
      (function wait() {
        if ($('state-profile') && !$('state-profile').hidden) apply(q);
        else if (tries++ < 50) setTimeout(wait, 100);
      })();
    }
  }

  window.NextGenStates = { apply: apply, states: STATES };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
