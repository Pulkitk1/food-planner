(function () {
  'use strict';
  const key = location.pathname.split('/')[2];
  const api = '/api/' + encodeURIComponent(key) + '/kitchen';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const POLL_MS = 4000; // pick up changes Claude makes while the page is open
  const TIP_TEXT = 'I have paneer, spinach and rice';
  const ASK_TEXT = 'What can I cook with what I have?';

  let items = [];
  let busy = 0; // requests in flight
  const input = $('add-input');

  async function call(method, path, body) {
    busy++;
    try {
      const res = await fetch(api + (path || ''), {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* no body */ }
      if (!res.ok) throw new Error((data && data.error) || 'Something went wrong');
      return data;
    } finally { busy--; }
  }

  // ---------- Toast ("Removed. Undo") ----------
  let toastTimer;
  function hideToast() { clearTimeout(toastTimer); $('toast-wrap').replaceChildren(); }
  function showToast(message, actionLabel, onAction) {
    const toast = el('div', 'toast');
    toast.append(el('span', null, message));
    if (actionLabel) {
      const b = el('button', 'toast-btn', actionLabel);
      b.type = 'button';
      b.addEventListener('click', onAction);
      toast.append(b);
    }
    const start = () => { clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, 7000); };
    toast.addEventListener('mouseenter', () => clearTimeout(toastTimer));
    toast.addEventListener('focusin', () => clearTimeout(toastTimer));
    toast.addEventListener('mouseleave', start);
    toast.addEventListener('focusout', start);
    $('toast-wrap').replaceChildren(toast);
    start();
  }

  // ---------- Render ----------
  // Re-draws the list. If a chip's button had focus, focus stays on that chip.
  function render() {
    const list = $('list');
    const a = document.activeElement;
    const focusedLi = a && a.closest ? a.closest('#list li') : null;
    const focusedId = focusedLi ? focusedLi.dataset.id : null;
    list.replaceChildren();
    items.forEach((item) => {
      const li = el('li', 'tag');
      li.dataset.id = item.id;
      li.append(el('span', null, item.name));
      const x = el('button', 'tag-x');
      x.type = 'button';
      x.setAttribute('aria-label', 'Remove ' + item.name);
      x.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      x.addEventListener('click', () => remove(item));
      li.append(x);
      list.append(li);
    });
    const n = items.length;
    $('count').textContent = n === 1 ? '1 ingredient' : n + ' ingredients';
    $('empty').hidden = n > 0;
    list.hidden = n === 0;
    $('ask').hidden = n === 0;
    if (focusedId) {
      const again = list.querySelector('li[data-id="' + focusedId + '"] .tag-x');
      if (again) again.focus();
      else input.focus();
    }
  }

  // ---------- Add ----------
  const msg = (t, isError) => { $('add-msg').textContent = t; $('add-msg').classList.toggle('is-error', !!isError); };

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const names = input.value.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    if (!names.length) { msg(''); input.focus(); return; }
    input.value = '';
    input.focus(); // keep typing
    const added = [], skipped = [], failed = [];
    for (const name of names) {
      // Duplicates in the list or in what was just typed are skipped (ignoring case).
      if (items.some((i) => i.name.toLowerCase() === name.toLowerCase())) { skipped.push(name); continue; }
      try {
        const data = await call('POST', '', { name });
        items = data.items;
        if (data.duplicate) skipped.push(name); else added.push(data.item.name);
      } catch (err) { failed.push(name); msg(err.message, true); }
    }
    render();
    hideToast();
    if (failed.length) {
      input.value = failed.join(', '); // give back what didn't save
      msg('Couldn’t add ' + failed.join(', ') + '. Check your connection and try again.', true);
      return;
    }
    const parts = [];
    if (added.length) parts.push('Added ' + added.join(', ') + '.');
    if (skipped.length) parts.push(skipped.join(', ') + (skipped.length === 1 ? ' is' : ' are') + ' already in your kitchen.');
    msg(parts.join(' '));
  });

  // ---------- Remove + Undo ----------
  async function remove(item) {
    const index = items.indexOf(item);
    items = items.filter((i) => i !== item); // immediately
    render();
    focusAfterRemove(index);
    try {
      const data = await call('DELETE', '/' + encodeURIComponent(item.id));
      items = data.items;
      render();
    } catch (err) {
      if (!/not found/i.test(err.message)) { // put it back if the server didn't remove it
        items.splice(Math.min(index, items.length), 0, item);
        render();
        showToast('Couldn’t remove ' + item.name + '. Try again.');
        return;
      }
    }
    showToast('Removed.', 'Undo', async () => {
      hideToast();
      try {
        const data = await call('POST', '', { name: item.name, addedAt: item.addedAt });
        items = data.items;
        render();
        msg('');
      } catch (err) { showToast('Couldn’t undo. ' + err.message); }
    });
  }
  // Keep keyboard focus nearby after a chip disappears.
  function focusAfterRemove(index) {
    const buttons = document.querySelectorAll('#list .tag-x');
    const next = buttons[Math.min(index, buttons.length - 1)];
    (next || input).focus();
  }

  // ---------- Copy buttons ----------
  function wireCopy(btnId, statusId, text) {
    let t;
    $(btnId).addEventListener('click', async () => {
      const ok = await FPProfile.copyText(text);
      const s = $(statusId);
      clearTimeout(t);
      s.classList.toggle('is-error', !ok);
      s.textContent = ok ? 'Copied' : 'Couldn’t copy. The text is: ' + text;
      t = setTimeout(() => { s.textContent = ''; }, ok ? 2000 : 8000);
    });
  }
  wireCopy('copy-tip', 'copy-tip-status', TIP_TEXT);
  wireCopy('copy-ask', 'copy-ask-status', ASK_TEXT);

  // ---------- Load + refresh ----------
  let loaded = false;
  async function load() {
    const data = await call('GET');
    const changed = !loaded || JSON.stringify(data.items) !== JSON.stringify(items);
    loaded = true;
    if (changed) {
      items = data.items;
      render();
    }
  }
  load().catch(() => {
    $('empty').hidden = false;
    $('empty').textContent = 'Could not load your kitchen. Check your connection and refresh.';
  });
  // Refresh while open, but not while something is being typed or saved.
  const typing = () => input.value.trim() !== '';
  setInterval(() => {
    if (document.hidden || busy || typing()) return;
    load().catch(() => {});
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !busy && !typing()) load().catch(() => {});
  });
})();
