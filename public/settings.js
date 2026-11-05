(function () {
  'use strict';
  const key = location.pathname.split('/')[2];
  const api = '/api/' + encodeURIComponent(key);
  const $ = (id) => document.getElementById(id);

  // ---------- Theme ----------
  if (window.fpTheme) {
    const radios = document.querySelectorAll('input[name="theme"]');
    const current = window.fpTheme.get();
    radios.forEach((r) => {
      r.checked = r.value === current;
      r.addEventListener('change', () => { if (r.checked) window.fpTheme.set(r.value); });
    });
  }

  // ---------- Meals shown ----------
  const SAVE_DELAY_MS = 500;
  const switches = Array.from(document.querySelectorAll('.switch-row[data-meal]'));
  let meals = null;
  let timer = null;
  let savedTimer = null;

  function renderSwitches() {
    switches.forEach((s) => { s.setAttribute('aria-checked', String(!!meals[s.dataset.meal])); });
  }
  function savedStatus(ok) {
    const s = $('meals-saved');
    clearTimeout(savedTimer);
    s.classList.toggle('is-error', !ok);
    s.textContent = ok ? 'Saved' : 'Couldn’t save. Check your connection and try again.';
    if (ok) savedTimer = setTimeout(() => { s.textContent = ''; }, 2500);
  }
  async function save() {
    timer = null;
    try {
      const res = await fetch(api + '/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meals }),
      });
      savedStatus(res.ok);
    } catch (_) { savedStatus(false); }
  }

  switches.forEach((s) => s.addEventListener('click', () => {
    if (!meals) return;
    const meal = s.dataset.meal;
    const onCount = Object.values(meals).filter(Boolean).length;
    if (meals[meal] && onCount === 1) {
      $('meals-msg').textContent = 'Keep at least one meal on.';
      return;
    }
    $('meals-msg').textContent = '';
    meals[meal] = !meals[meal];
    renderSwitches();
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY_MS);
  }));

  fetch(api + '/settings', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
    .then((data) => {
      meals = data.settings.meals;
      renderSwitches();
      switches.forEach((s) => { s.disabled = false; });
    })
    .catch(() => { $('meals-msg').textContent = 'Could not load your settings. Refresh to try again.'; });

  // ---------- Delete my account ----------
  const dialog = $('delete-dialog');
  const confirmInput = $('delete-confirm');
  const finalBtn = $('delete-final');
  const opener = $('delete-open');

  function openDialog() {
    confirmInput.value = '';
    finalBtn.disabled = true;
    $('delete-error').textContent = '';
    dialog.showModal();
    confirmInput.focus();
  }
  function closeDialog() {
    if (dialog.open) dialog.close();
  }
  opener.addEventListener('click', openDialog);
  $('delete-cancel').addEventListener('click', closeDialog);
  dialog.addEventListener('close', () => opener.focus());
  // Escape closes (the browser fires "cancel" for it); clicking the backdrop does too.
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(); });

  // Keep Tab inside the dialog.
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = Array.from(dialog.querySelectorAll('input, button')).filter((x) => !x.disabled);
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  confirmInput.addEventListener('input', () => { finalBtn.disabled = confirmInput.value.trim() !== 'DELETE'; });
  confirmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !finalBtn.disabled) finalBtn.click(); });

  finalBtn.addEventListener('click', async () => {
    if (confirmInput.value.trim() !== 'DELETE') return;
    finalBtn.disabled = true;
    $('delete-error').textContent = '';
    try {
      const res = await fetch(api, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      try { if (localStorage.getItem('fp_workspace') === key) localStorage.removeItem('fp_workspace'); } catch (_) { /* storage blocked */ }
      location.replace('/?deleted=1');
    } catch (_) {
      $('delete-error').textContent = 'Couldn’t delete. Check your connection and try again.';
      finalBtn.disabled = false;
    }
  });
})();
