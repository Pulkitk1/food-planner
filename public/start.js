// Start page: if this browser remembers a workspace that still exists, offer
// "Continue to my planner" and make a new workspace a confirmed, secondary action.
// Never creates a workspace by itself.
(function () {
  'use strict';
  const K = 'fp_workspace';
  const $ = (id) => document.getElementById(id);
  const get = () => { try { return localStorage.getItem(K); } catch (_) { return null; } };
  const clear = () => { try { localStorage.removeItem(K); } catch (_) { /* storage blocked */ } };

  const saved = get();
  if (!saved || !/^[A-Za-z0-9_-]{8,64}$/.test(saved)) { if (saved) clear(); return; }

  function showContinue() {
    $('continue-link').href = '/w/' + encodeURIComponent(saved);
    $('continue-area').hidden = false;
    const btn = $('start-btn');
    btn.textContent = 'Start a new workspace';
    btn.classList.add('btn-ghost');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'start-confirm');
    $('start-hint').textContent = 'This browser remembers your planner. Your link is your key, so bookmark it too.';

    const box = $('start-confirm');
    const open = (yes) => {
      box.hidden = !yes;
      btn.setAttribute('aria-expanded', String(yes));
      if (yes) $('start-no').focus();
    };
    $('start-form').addEventListener('submit', (e) => { e.preventDefault(); open(box.hidden); });
    $('start-no').addEventListener('click', () => { open(false); btn.focus(); });
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { open(false); btn.focus(); } });
    $('start-yes').addEventListener('click', () => { $('start-yes').disabled = true; $('start-form').submit(); });
  }

  fetch('/api/' + encodeURIComponent(saved) + '/settings', { cache: 'no-store' })
    .then((res) => {
      if (res.status === 404) { clear(); return; } // deleted: normal start page
      showContinue(); // ok, or a server hiccup: still offer the way back
    })
    .catch(showContinue); // offline: the link may still work later
})();
