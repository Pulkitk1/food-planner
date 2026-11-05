(function () {
  'use strict';
  const key = location.pathname.split('/')[2];
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 4000; // pick up changes Claude makes while the page is open
  let resetting = false; // while a link reset is in flight, polling doesn't touch the link

  // ---------- Collapsible sections ----------
  // Each .sec has a toggle button (aria-expanded) and a content region that is
  // `hidden` while closed, so nothing inside can be reached by keyboard.
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ANIM_MS = 200;
  function setOpen(sec, open) {
    const btn = sec.querySelector('.sec-btn');
    const body = sec.querySelector('.sec-body');
    if ((btn.getAttribute('aria-expanded') === 'true') === open) return;
    btn.setAttribute('aria-expanded', String(open));
    sec.classList.toggle('is-open', open);
    clearTimeout(body._t);
    if (open) {
      body.hidden = false;
      if (reduceMotion) { body.classList.add('open'); return; }
      void body.offsetHeight; // start the animation from closed
      body.classList.add('open');
    } else {
      body.classList.remove('open');
      if (reduceMotion) { body.hidden = true; return; }
      body._t = setTimeout(() => { if (btn.getAttribute('aria-expanded') === 'false') body.hidden = true; }, ANIM_MS);
    }
  }
  const sections = Array.from(document.querySelectorAll('.sec'));
  sections.forEach((sec) => {
    sec.querySelector('.sec-btn').addEventListener('click', (e) => {
      setOpen(sec, e.currentTarget.getAttribute('aria-expanded') !== 'true');
    });
  });
  // Deep links: #food-preferences, #claude, #account, #invite open that section.
  function openFromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    const sec = id && sections.find((s) => s.id === id);
    if (!sec) return;
    setOpen(sec, true);
    requestAnimationFrame(() => sec.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' }));
  }
  openFromHash();
  window.addEventListener('hashchange', openFromHash);

  // ---------- Summary lines ----------
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  // e.g. "Vegetarian · North Indian · Normal"; "Not set yet" when nothing is saved.
  function foodSummary(p) {
    if (!p) return 'Not set yet';
    const parts = [];
    if (p.diet) parts.push(cap(p.diet));
    if (p.cuisines && p.cuisines.length) parts.push(p.cuisines.join(', '));
    if (p.taste) parts.push(cap(p.taste));
    return parts.length ? parts.join(' · ') : 'Not set yet';
  }
  const setFoodSummary = (p) => { $('sum-food').textContent = foodSummary(p); };

  // Save status: quiet "Saved", or an error that stays until the next good save.
  let savedTimer;
  const editor = FPProfile.createEditor({
    key,
    onStatus(state) {
      const s = $('save-status');
      clearTimeout(savedTimer);
      if (state === 'saved') {
        setFoodSummary(editor.getProfile());
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
    $('sum-claude-dot').classList.toggle('on', connected);
    $('sum-claude').textContent = connected ? 'Connected' : 'Not connected yet';
  }

  async function fetchProfile() {
    const res = await fetch('/api/' + encodeURIComponent(key) + '/profile', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  let mountedFields = false;
  async function load(first) {
    const data = await fetchProfile();
    if (first) {
      // First-time visitors (never saved preferences) start with this section open.
      if (!data.profileSaved) setOpen($('food-preferences'), true);
    }
    if (first || !editor.busy()) setFoodSummary(data.profileSaved ? data.profile : null);
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
    $('sum-account').textContent = s.trialEnded ? 'Free during launch' : 'Free trial · Day ' + s.trialDay + ' of ' + s.trialDays;
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
    .catch(() => { $('sum-account').textContent = 'Couldn’t load your plan'; $('trial-status').replaceChildren(Object.assign(document.createElement('p'), { className: 'error', textContent: 'Could not load your plan. Refresh to try again.' })); });

  // Invite a friend: share link only (no rewards yet, nothing collected).
  let inviteUrl = '', inviteMsg = '';
  fetch('/api/' + encodeURIComponent(key) + '/invite', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
    .then((d) => {
      inviteUrl = d.inviteUrl;
      inviteMsg = 'I use Food Planner to plan my meals with Claude. Try it free for ' + d.trialDays + ' days: ';
      $('invite-link').value = inviteUrl;
      $('invite-share').href = 'https://wa.me/?text=' + encodeURIComponent(inviteMsg + inviteUrl);
    })
    .catch(() => { $('invite-link').value = 'Couldn’t load your invite link. Refresh to try again.'; });
  $('invite-link').addEventListener('focus', () => $('invite-link').select());
  let inviteTimer;
  $('invite-copy').addEventListener('click', async () => {
    if (!inviteUrl) return;
    const ok = await FPProfile.copyText(inviteUrl);
    clearTimeout(inviteTimer);
    const btn = $('invite-copy'), st = $('invite-copy-status');
    if (ok) {
      btn.textContent = 'Copied';
      st.textContent = 'Invite link copied';
      st.classList.remove('is-error');
      inviteTimer = setTimeout(() => { btn.textContent = 'Copy'; st.textContent = ''; }, 2000);
    } else {
      $('invite-link').focus();
      st.textContent = 'Couldn’t copy automatically. The link is selected: press Ctrl+C (or long-press and Copy).';
      st.classList.add('is-error');
    }
  });
  // On small screens, use the phone's own share sheet when there is one; otherwise WhatsApp.
  $('invite-share').addEventListener('click', async (e) => {
    if (!inviteUrl) { e.preventDefault(); return; }
    const small = window.matchMedia && matchMedia('(max-width: 640px)').matches;
    if (!small || !navigator.share) return; // follow the wa.me link
    e.preventDefault();
    try {
      await navigator.share({ title: 'Food Planner', text: inviteMsg, url: inviteUrl });
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user closed the share sheet
      window.open($('invite-share').href, '_blank', 'noopener,noreferrer');
    }
  });

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
