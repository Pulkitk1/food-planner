// Home: one quiet line about the free trial, linking to the Account card.
// Hidden for the rest of the day once dismissed (remembered in this browser).
(function () {
  'use strict';
  const key = location.pathname.split('/')[2];
  const $ = (id) => document.getElementById(id);
  const K = 'fp_trial_note_hidden';
  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  try { if (localStorage.getItem(K) === today) return; } catch (_) { /* storage blocked: just show it */ }

  fetch('/api/' + encodeURIComponent(key) + '/subscription', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (!s) return;
      $('trial-note-link').textContent = s.trialEnded
        ? 'Free during launch'
        : 'Free trial: ' + s.trialDaysLeft + (s.trialDaysLeft === 1 ? ' day left' : ' days left');
      $('trial-note').hidden = false;
    })
    .catch(() => { /* leave it hidden */ });

  $('trial-note-x').addEventListener('click', () => {
    try { localStorage.setItem(K, today); } catch (_) { /* hidden for this page view only */ }
    $('trial-note').hidden = true;
    $('greeting').setAttribute('tabindex', '-1');
    $('greeting').focus(); // keep keyboard focus somewhere sensible
  });
})();
