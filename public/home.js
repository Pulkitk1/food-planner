(function () {
  const key = location.pathname.split('/')[2];
  const pad2 = (x) => String(x).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const MEALS = [
    { key: 'breakfast', label: 'Breakfast' },
    { key: 'lunch', label: 'Lunch' },
    { key: 'dinner', label: 'Dinner' },
  ];
  // Meals switched off in Settings are hidden (their data is kept).
  const visibleMeals = (settings) => {
    const on = (settings && settings.meals) || {};
    return MEALS.filter((m) => on[m.key] !== false);
  };
  let shown = MEALS;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmt = (x) => Math.round(x).toLocaleString('en-IN');
  const hasNutrition = (d) => d && d.nutrition && d.nutrition.calories != null;

  let todayMeals = {};

  function renderGreeting(now) {
    const h = now.getHours();
    $('greeting').textContent = h >= 5 && h < 12 ? 'Good morning' : h >= 12 && h < 17 ? 'Good afternoon' : 'Good evening';
    $('today-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function renderMeals(dayPlan) {
    const list = $('meals');
    list.replaceChildren();
    for (const m of shown) {
      const dish = dayPlan[m.key];
      const li = el('li', 'meal-card' + (dish ? '' : ' empty'));
      li.append(el('p', 'label', m.label));
      if (!dish) {
        li.append(el('p', 'dish', 'Add a dish, or ask Claude to plan it.'));
      } else {
        li.append(el('p', 'dish', dish.name));
        if (hasNutrition(dish)) {
          const n = dish.nutrition;
          const parts = ['About ' + fmt(n.calories) + ' kcal'];
          if (n.protein != null) parts.push(fmt(n.protein) + 'g protein');
          li.append(el('p', 'meta', parts.join(' · ') + ' (estimate)'));
        } else {
          li.append(el('p', 'meta missing', 'Nutrition missing'));
        }
      }
      list.append(li);
    }
  }

  function renderTotals(dayPlan) {
    const box = $('totals');
    const dishes = shown.map((m) => dayPlan[m.key]).filter(Boolean);
    const counted = dishes.filter(hasNutrition);
    box.replaceChildren();
    if (counted.length === 0) { box.hidden = true; return; }
    const sum = (k) => counted.reduce((a, d) => a + (Number(d.nutrition[k]) || 0), 0);
    box.append(el('p', 'kcal', 'About ' + fmt(sum('calories')) + ' kcal today (estimate)'));
    box.append(el('p', 'macros',
      'Protein ~' + fmt(sum('protein')) + 'g · Carbs ~' + fmt(sum('carbs')) + 'g · Fat ~' + fmt(sum('fat')) + 'g (estimates)'));
    const missing = dishes.length - counted.length;
    if (missing > 0) {
      box.append(el('p', 'note', 'Leaves out ' + missing + (missing === 1 ? ' dish' : ' dishes') + ' with no nutrition.'));
    }
    box.hidden = false;
  }

  function renderStatus(connected) {
    $('status-dot').classList.toggle('on', connected);
    $('status-text').textContent = connected ? 'Claude connected' : 'Claude not connected yet';
  }

  function cookMessage() {
    const parts = shown.filter((m) => todayMeals[m.key])
      .map((m) => todayMeals[m.key].name.toLowerCase() + ' for ' + m.key);
    if (parts.length === 0) return 'Nothing planned for today yet.';
    return 'Today: ' + parts.join(', ');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Fallback for non-secure contexts (e.g. opening via a LAN IP on a phone).
      const ta = el('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  let copiedTimer;
  $('tell-cook').addEventListener('click', async () => {
    const msg = cookMessage();
    const ok = await copyText(msg);
    const out = $('copied');
    out.textContent = ok ? 'Copied' : 'Could not copy. Here it is: ' + msg;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { out.textContent = ''; }, ok ? 2000 : 8000);
  });

  let lastShown = null; // what's on screen, to skip re-drawing when nothing changed
  async function load(quiet) {
    const now = new Date();
    renderGreeting(now);
    try {
      const today = ymd(now);
      const res = await fetch('/api/' + encodeURIComponent(key) + '/plan?from=' + today + '&to=' + today, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      renderStatus(!!data.claudeConnected);
      const snapshot = JSON.stringify([today, data.plan[today] || {}, data.settings]);
      if (snapshot === lastShown) return;
      lastShown = snapshot;
      todayMeals = data.plan[today] || {};
      shown = visibleMeals(data.settings);
      renderMeals(todayMeals);
      renderTotals(todayMeals);
    } catch (e) {
      if (quiet) return; // a background refresh failing just keeps what's shown
      $('meals').replaceChildren(el('li', 'meal-card error', 'Could not load your plan. Check your connection and refresh.'));
      $('status-text').textContent = 'Could not check Claude';
    }
  }

  load(false);
  // Pick up changes Claude makes while the page is open, and when coming back to the tab.
  const POLL_MS = 5000;
  setInterval(() => { if (!document.hidden) load(true); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });
})();
