(function () {
  'use strict';
  const key = location.pathname.split('/')[2];
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 4000; // pick up changes Claude makes while the page is open
  let resetting = false; // while a link reset is in flight, polling doesn't touch the link

  // Save status: quiet "Saved", or an error that stays until the next good save.
  let savedTimer;
  const editor = FPProfile.createEditor({
    key,
    onStatus(state) {
      const s = $('save-status');
      clearTimeout(savedTimer);
      if (state === 'saved') {
        s.textContent = 'Saved';
        s.classList.remove('is-error');
        savedTimer = setTimeout(() => { s.textContent = ''; }, 2500);
      } else {
        s.textContent = 'Couldn’t save. Check your connection and try again.';
        s.classList.add('is-error');
      }
    },
  });

  const link = FPProfile.linkBox();
  $('link-slot').append(link.el);
  $('steps-slot').append(FPProfile.connectSteps());

  function showStatus(connected) {
    $('status-dot').classList.toggle('on', connected);
    $('status-text').textContent = connected ? 'Claude connected' : 'Claude not connected yet';
  }

  async function fetchProfile() {
    const res = await fetch('/api/' + encodeURIComponent(key) + '/profile', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  let mountedFields = false;
  async function load(first) {
    const data = await fetchProfile();
    if (!mountedFields) {
      editor.setProfile(data.profile, true); // before mounting, so fields start with saved values
      const box = $('prefs');
      box.replaceChildren(
        editor.field('diet'), editor.field('cuisines'), editor.field('taste'),
        editor.field('dislikes'), editor.field('allergies'));
      mountedFields = true;
    } else {
      editor.setProfile(data.profile); // ignored while the user is editing
    }
    if (first || !resetting) link.setUrl(data.mcpUrl);
    showStatus(!!data.claudeConnected);
  }

  load(true).catch(() => {
    $('prefs').replaceChildren(Object.assign(document.createElement('p'), {
      className: 'error', textContent: 'Could not load your profile. Check your connection and refresh.',
    }));
  });

  setInterval(() => {
    if (document.hidden || !mountedFields || editor.busy()) return;
    load(false).catch(() => { /* try again next time */ });
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && mountedFields && !editor.busy()) load(false).catch(() => {});
  });

  // Account card: plan and trial (display only; no payments yet).
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  function renderAccount(s) {
    const box = $('trial-status');
    const p = (cls, text) => Object.assign(document.createElement('p'), { className: cls, textContent: text });
    if (s.trialEnded) {
      box.replaceChildren(
        p('trial-line', 'Your free trial has ended'),
        p('pf-hint', 'Payments aren’t switched on yet, so everything stays free for now.'));
    } else {
      const ends = parseYmd(s.trialEndsOn).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
      const row = document.createElement('div');
      row.className = 'trial-row';
      row.append(p('', 'Day ' + s.trialDay + ' of ' + s.trialDays), p('', 'Ends on ' + ends));
      const bar = document.createElement('div');
      bar.className = 'trial-bar';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', 'Free trial progress');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(s.trialDays));
      bar.setAttribute('aria-valuenow', String(s.trialDay));
      bar.setAttribute('aria-valuetext', 'Day ' + s.trialDay + ' of ' + s.trialDays);
      const fill = document.createElement('span');
      fill.style.width = Math.round((s.trialDay / s.trialDays) * 100) + '%';
      bar.append(fill);
      box.replaceChildren(p('trial-line', 'You’re using the free trial'), row, bar);
    }
    $('tile-trial').classList.toggle('is-current', !s.trialEnded);
    $('trial-length').textContent = 'for ' + s.trialDays + ' days';
    $('paid-price').textContent = '₹' + s.priceLaunch + ' / month';
    $('paid-later').textContent = 'Launch price, rises to ₹' + s.priceLater;
    $('paid-after').textContent = String(s.trialDays);
    $('year-price').textContent = '₹' + s.priceYearlyLaunch + ' / year';
    $('year-per-month').textContent = 'About ₹' + s.yearlyPerMonth + ' a month, saves about ' + s.yearlySavingPct + '%';
    $('year-later').textContent = 'Launch price, rises to ₹' + s.priceYearlyLater;
  }
  fetch('/api/' + encodeURIComponent(key) + '/subscription', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
    .then(renderAccount)
    .catch(() => { $('trial-status').replaceChildren(Object.assign(document.createElement('p'), { className: 'error', textContent: 'Could not load your plan. Refresh to try again.' })); });

  // Copy the planner link (the Home page of this workspace).
  $('copy-page-link').addEventListener('click', async () => {
    const ok = await FPProfile.copyText(location.origin + '/w/' + encodeURIComponent(key));
    $('copy-page-status').textContent = ok ? 'Copied' : 'Couldn’t copy. Copy the address from your browser bar instead.';
  });

  // Reset link, with an inline confirmation.
  const confirmBox = $('reset-confirm');
  function openConfirm(open) {
    confirmBox.hidden = !open;
    $('reset-link').setAttribute('aria-expanded', String(open));
    if (open) $('reset-no').focus();
  }
  $('reset-link').addEventListener('click', () => { $('reset-status').textContent = ''; openConfirm(confirmBox.hidden); });
  $('reset-no').addEventListener('click', () => { openConfirm(false); $('reset-link').focus(); });
  confirmBox.addEventListener('keydown', (e) => { if (e.key === 'Escape') { openConfirm(false); $('reset-link').focus(); } });
  $('reset-yes').addEventListener('click', async () => {
    resetting = true;
    $('reset-yes').disabled = true;
    try {
      const res = await fetch('/api/' + encodeURIComponent(key) + '/mcp-link/reset', { method: 'POST' });
      if (!res.ok) throw new Error();
      const data = await res.json();
      link.setUrl(data.mcpUrl);
      showStatus(false);
      openConfirm(false);
      $('reset-status').textContent = 'Done. Here’s your new link. Copy it into Claude again.';
      $('reset-status').classList.remove('is-error');
      link.copyButton.focus();
    } catch (_) {
      $('reset-status').textContent = 'Couldn’t reset the link. Check your connection and try again.';
      $('reset-status').classList.add('is-error');
    } finally {
      $('reset-yes').disabled = false;
      resetting = false;
    }
  });
})();
