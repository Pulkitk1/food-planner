(function () {
  'use strict';

  const key = location.pathname.split('/')[2];
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
  const FIELDS = [
    { key: 'calories', label: 'Calories', unit: '', inputLabel: 'Calories (kcal)' },
    { key: 'protein', label: 'Protein', unit: 'g', inputLabel: 'Protein (g)' },
    { key: 'carbs', label: 'Carbs', unit: 'g', inputLabel: 'Carbs (g)' },
    { key: 'fat', label: 'Fat', unit: 'g', inputLabel: 'Fat (g)' },
    { key: 'fibre', label: 'Fibre', unit: 'g', inputLabel: 'Fibre (g)' },
  ];

  // The "Balanced" pill rule. A fixed rule, not AI, and only a rough guide.
  // Each nutrient's share of total calories must fall inside [min, max].
  // Change the numbers here to change the rule.
  const BALANCE_RULE = {
    protein: { min: 0.10, max: 0.35, kcalPerGram: 4 },
    fat: { min: 0.20, max: 0.35, kcalPerGram: 9 },
    carbs: { min: 0.45, max: 0.65, kcalPerGram: 4 },
  };

  // Date strip: chips for 30 days back to 60 days ahead, scrolled so that it
  // starts 2 days before today.
  const STRIP_DAYS_BEFORE = 30;
  const STRIP_DAYS_AFTER = 60;
  const STRIP_START_OFFSET = -2;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const pad2 = (x) => String(x).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const parseYmd = (s) => { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const fmt = (x) => Math.round(x).toLocaleString('en-IN');
  const hasNutrition = (slot) => !!(slot && slot.nutrition && slot.nutrition.calories != null);

  const todayDate = new Date();
  const state = { plan: {}, today: ymd(todayDate), selected: ymd(todayDate), editing: null };

  let inflight = 0; // requests in progress
  let writes = 0;   // counts saves, so a background refresh can tell if one happened meanwhile
  async function api(method, path, body) {
    inflight++;
    if (method !== 'GET') writes++;
    try {
      const res = await fetch('/api/' + encodeURIComponent(key) + '/plan' + path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* no body */ }
      if (!res.ok) throw new Error((data && data.error) || 'Something went wrong');
      return data;
    } finally {
      inflight--;
    }
  }

  function setSlot(date, meal, slot) {
    if (!state.plan[date]) state.plan[date] = {};
    state.plan[date][meal] = slot;
  }

  // ---------- Toast ("Removed. Undo") ----------
  let toastTimer;
  function hideToast() {
    clearTimeout(toastTimer);
    $('toast-wrap').replaceChildren();
  }
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
    const pause = () => clearTimeout(toastTimer);
    toast.addEventListener('mouseenter', pause);
    toast.addEventListener('focusin', pause);
    toast.addEventListener('mouseleave', start);
    toast.addEventListener('focusout', start);
    $('toast-wrap').replaceChildren(toast);
    start();
  }

  // ---------- Date strip ----------
  function chips() { return Array.from($('strip').children); }

  function updateChips() {
    for (const c of chips()) {
      const on = c.dataset.date === state.selected;
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
      c.tabIndex = on ? 0 : -1; // one tab stop; arrow keys move between days
    }
  }

  function buildStrip() {
    const strip = $('strip');
    const base = parseYmd(state.today);
    for (let i = -STRIP_DAYS_BEFORE; i <= STRIP_DAYS_AFTER; i++) {
      const d = addDays(base, i);
      const s = ymd(d);
      const isToday = s === state.today;
      const b = el('button', 'chip' + (isToday ? ' today' : ''));
      b.type = 'button';
      b.dataset.date = s;
      // Every chip reserves the month row; only the 1st of a month fills it.
      if (d.getDate() === 1) b.classList.add('month-start');
      b.append(
        el('span', 'chip-mon', d.getDate() === 1 ? d.toLocaleDateString(undefined, { month: 'short' }) : ''),
        el('span', 'chip-dow', d.toLocaleDateString(undefined, { weekday: 'short' })),
        el('span', 'chip-num', String(d.getDate()))
      );
      b.setAttribute('aria-label',
        d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) + (isToday ? ', today' : ''));
      b.addEventListener('click', () => select(s));
      strip.append(b);
    }
    updateChips();
    const first = strip.querySelector('[data-date="' + ymd(addDays(base, STRIP_START_OFFSET)) + '"]');
    if (first) strip.scrollLeft = first.offsetLeft - 6; // 6px = strip padding

    strip.addEventListener('keydown', (e) => {
      const all = chips();
      const i = all.indexOf(document.activeElement);
      if (i < 0) return;
      let next = null;
      if (e.key === 'ArrowRight') next = all[Math.min(i + 1, all.length - 1)];
      else if (e.key === 'ArrowLeft') next = all[Math.max(i - 1, 0)];
      else if (e.key === 'Home') next = all[0];
      else if (e.key === 'End') next = all[all.length - 1];
      if (!next) return;
      e.preventDefault();
      document.activeElement.tabIndex = -1; // roving tabindex: the focused chip is the tab stop
      next.tabIndex = 0;
      next.focus();
    });

    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const page = (dir) => strip.scrollBy({ left: dir * strip.clientWidth * 0.8, behavior: reduce ? 'auto' : 'smooth' });
    $('strip-prev').addEventListener('click', () => page(-1));
    $('strip-next').addEventListener('click', () => page(1));

    // Month label follows the chip nearest the centre of the visible strip
    // (scrolling, swiping and the arrow buttons all fire scroll events).
    let ticking = false;
    strip.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; updateMonthLabel(); });
    }, { passive: true });
    window.addEventListener('resize', updateMonthLabel);
    updateMonthLabel();
    updateSelectedLine();
  }

  function updateMonthLabel() {
    const strip = $('strip');
    const centre = strip.scrollLeft + strip.clientWidth / 2;
    let best = null, bestDist = Infinity;
    for (const c of chips()) {
      const dist = Math.abs(c.offsetLeft + c.offsetWidth / 2 - centre);
      if (dist < bestDist) { bestDist = dist; best = c; }
    }
    if (!best) return;
    const text = parseYmd(best.dataset.date).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if ($('month-label').textContent !== text) $('month-label').textContent = text;
  }

  function updateSelectedLine() {
    const line = $('selected-date');
    line.textContent = parseYmd(state.selected).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    if (state.selected === state.today) line.append(el('span', 'selected-today', ' · Today'));
  }

  function select(date) {
    state.selected = date;
    state.editing = null;
    updateChips();
    updateSelectedLine();
    render();
  }

  // ---------- Meal cards ----------
  function filledCard(m, slot) {
    const li = el('li', 'meal-card planner-card filled');
    li.dataset.meal = m.key;
    li.append(el('p', 'label', m.label));

    const nameBtn = el('button', 'dish-btn', slot.name);
    nameBtn.type = 'button';
    nameBtn.title = 'Edit dish';
    nameBtn.setAttribute('aria-label', 'Edit ' + slot.name + ' (' + m.label + ')');
    nameBtn.addEventListener('click', () => openForm(m.key));
    li.append(nameBtn);

    if (hasNutrition(slot)) {
      const n = slot.nutrition;
      let line = '~' + fmt(n.calories) + ' kcal';
      if (n.protein != null) line += ' · ' + fmt(n.protein) + 'g protein';
      li.append(el('p', 'meta', line));
    } else {
      li.append(el('p', 'meta missing', 'Nutrition missing'));
    }

    const foot = el('div', 'card-foot');
    const remove = el('button', 'link-btn', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove ' + slot.name + ' from ' + m.label);
    remove.addEventListener('click', () => removeSlot(m, slot));

    foot.append(remove);
    li.append(foot);
    return li;
  }

  function emptyCard(m) {
    const li = el('li', 'meal-card planner-card empty');
    li.dataset.meal = m.key;
    li.append(el('p', 'label', m.label));
    const add = el('button', 'btn add-btn', '+ Add ' + m.label);
    add.type = 'button';
    add.addEventListener('click', () => openForm(m.key));
    li.append(add);
    return li;
  }

  function field(label, id, input) {
    const wrap = el('div', 'field');
    const l = el('label', null, label);
    l.htmlFor = id;
    input.id = id;
    wrap.append(l, input);
    return wrap;
  }

  function formCard(m, slot) {
    const date = state.selected;
    const li = el('li', 'meal-card planner-card form-card');
    li.dataset.meal = m.key;
    li.append(el('p', 'label', m.label));

    const form = el('form', 'dish-form');
    form.noValidate = true;
    form.setAttribute('aria-label', (slot ? 'Edit ' : 'Add ') + m.label);

    const name = el('input');
    name.type = 'text';
    name.required = true;
    name.maxLength = 120;
    name.autocomplete = 'off';
    name.value = slot ? slot.name : '';
    form.append(field('Dish name', 'f-name', name));

    const fs = el('fieldset', 'nutri-fields');
    fs.append(el('legend', null, 'Nutrition (optional, estimates)'));
    const grid = el('div', 'nutri-grid');
    const inputs = {};
    for (const f of FIELDS) {
      const inp = el('input');
      inp.type = 'number';
      inp.inputMode = 'decimal';
      inp.min = '0';
      inp.step = 'any';
      const cur = slot && slot.nutrition ? slot.nutrition[f.key] : null;
      inp.value = cur == null ? '' : String(cur);
      inputs[f.key] = inp;
      grid.append(field(f.inputLabel, 'f-' + f.key, inp));
    }
    fs.append(grid);
    form.append(fs);

    form.append(el('p', 'tip', 'Leave nutrition blank and ask Claude: fill in my nutrition.'));

    const error = el('p', 'form-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    form.append(error);
    const fail = (msg, input) => { error.textContent = msg; error.hidden = false; if (input) input.focus(); };

    const actions = el('div', 'form-actions');
    const save = el('button', 'btn', 'Save dish');
    save.type = 'submit';
    const cancel = el('button', 'btn btn-ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => closeForm(m.key, slot));
    actions.append(save, cancel);
    form.append(actions);

    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeForm(m.key, slot); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.hidden = true;
      const dishName = name.value.trim();
      if (!dishName) return fail('Add a dish name.', name);
      const nutrition = {};
      let any = false;
      for (const f of FIELDS) {
        const raw = inputs[f.key].value.trim();
        if (raw === '') { nutrition[f.key] = null; continue; }
        const num = Number(raw);
        if (!Number.isFinite(num) || num < 0 || num > 10000) return fail(f.label + ' should be a number from 0 to 10000.', inputs[f.key]);
        nutrition[f.key] = num;
        any = true;
      }
      if (any && nutrition.calories == null) return fail('Add calories too, or leave nutrition blank.', inputs.calories);

      save.disabled = true;
      try {
        const res = await api('PUT', '/' + date + '/' + m.key, { name: dishName, nutrition: any ? nutrition : null });
        setSlot(date, m.key, res.dish);
        hideToast();
        state.editing = null;
        render({ meal: m.key, sel: '.dish-btn' });
      } catch (err) {
        save.disabled = false;
        fail(err.message);
      }
    });

    li.append(form);
    return li;
  }

  function renderMeals() {
    const day = state.plan[state.selected] || {};
    $('empty-note').hidden = shown.some((m) => day[m.key]);
    const list = $('meals');
    list.replaceChildren();
    for (const m of shown) {
      const slot = day[m.key] || null;
      if (state.editing === m.key) list.append(formCard(m, slot));
      else list.append(slot ? filledCard(m, slot) : emptyCard(m));
    }
  }

  function openForm(mealKey) {
    state.editing = mealKey;
    render();
    const input = $('f-name');
    if (input) { input.focus(); input.select(); }
  }

  function closeForm(mealKey, slot) {
    state.editing = null;
    render({ meal: mealKey, sel: slot ? '.dish-btn' : '.add-btn' });
  }

  async function removeSlot(m, slot) {
    const date = state.selected;
    try {
      await api('DELETE', '/' + date + '/' + m.key);
    } catch (err) {
      return showToast(err.message);
    }
    setSlot(date, m.key, null);
    render({ meal: m.key, sel: '.add-btn' });
    showToast('Removed.', 'Undo', async () => {
      try {
        const res = await api('PUT', '/' + date + '/' + m.key,
          { name: slot.name, nutrition: slot.nutrition });
        setSlot(date, m.key, res.dish);
        hideToast();
        if (date === state.selected && !state.editing) render({ meal: m.key, sel: '.dish-btn' });
      } catch (err) {
        showToast(err.message);
      }
    });
  }

  // ---------- Nutrition card ----------
  function balanceVerdict(counted) {
    if (counted.length === 0) return null;
    // Can't judge the split if a dish has calories but no protein, carbs or fat.
    const complete = counted.every((s) => ['protein', 'carbs', 'fat'].every((k) => s.nutrition[k] != null));
    if (!complete) return null;
    const sum = (k) => counted.reduce((a, s) => a + (Number(s.nutrition[k]) || 0), 0);
    const kcal = sum('calories');
    if (kcal <= 0) return null;
    const balanced = Object.keys(BALANCE_RULE).every((k) => {
      const r = BALANCE_RULE[k];
      const share = (sum(k) * r.kcalPerGram) / kcal;
      return share >= r.min && share <= r.max;
    });
    return balanced ? 'Balanced' : 'Needs balance';
  }

  function renderNutrition() {
    const day = state.plan[state.selected] || {};
    const slots = shown.map((m) => day[m.key]).filter(Boolean);
    const counted = slots.filter(hasNutrition);
    const isToday = state.selected === state.today;
    const d = parseYmd(state.selected);

    $('nutrition-title').textContent = isToday
      ? 'Today’s nutrition'
      : 'Nutrition for ' + d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d.getDate();

    const stats = $('stats');
    stats.replaceChildren();
    for (const f of FIELDS) {
      const li = el('li', 'stat');
      let value = '–';
      if (counted.length) {
        const total = counted.reduce((a, s) => a + (Number(s.nutrition[f.key]) || 0), 0);
        value = fmt(total) + f.unit;
      }
      li.append(el('strong', null, value), el('span', null, f.label));
      stats.append(li);
    }

    const pill = $('pill');
    const verdict = balanceVerdict(counted);
    pill.hidden = !verdict;
    if (verdict) {
      pill.textContent = verdict;
      pill.className = 'pill ' + (verdict === 'Balanced' ? 'balanced' : 'needs');
      pill.title = 'A rough guide only, not medical advice.';
    }

    const missing = slots.length - counted.length;
    const note = $('nutri-missing');
    note.hidden = missing === 0;
    if (missing) {
      note.textContent = missing === 1
        ? '1 dish has no nutrition yet. Ask Claude to fill it in.'
        : missing + ' dishes have no nutrition yet. Ask Claude to fill them in.';
    }

    $('nutri-foot').textContent = 'Based on meals planned ' +(isToday ? 'today' : 'this day') + '. Estimated values.';
    $('nutrition').hidden = false;
  }

  function render(focus) {
    renderMeals();
    renderNutrition();
    if (focus) {
      const target = document.querySelector('[data-meal="' + focus.meal + '"] ' + focus.sel);
      if (target) target.focus();
    }
  }

  // ---------- Loading ----------
  async function fetchPlan() {
    const base = parseYmd(state.today);
    const from = ymd(addDays(base, -STRIP_DAYS_BEFORE));
    const to = ymd(addDays(base, STRIP_DAYS_AFTER));
    const data = await api('GET', '?from=' + from + '&to=' + to);
    return data;
  }
  function apply(data) {
    state.plan = data.plan;
    shown = visibleMeals(data.settings);
  }

  buildStrip();
  fetchPlan().then((data) => { apply(data); render(); }).catch(() => {
    $('meals').replaceChildren(el('li', 'meal-card error', 'Could not load your plan. Check your connection and refresh.'));
  });

  // Pick up changes Claude makes while the page is open. Skipped while a dish is being
  // added or edited or a save is in progress. The selected date and keyboard focus stay put.
  const POLL_MS = 5000;
  async function refresh() {
    if (document.hidden || state.editing || inflight) return;
    const writesBefore = writes;
    let data;
    try { data = await fetchPlan(); } catch (_) { return; } // keep showing what we have
    if (state.editing || writes !== writesBefore) return; // the user changed something meanwhile
    const before = JSON.stringify([state.plan, shown.map((m) => m.key)]);
    apply(data);
    if (JSON.stringify([state.plan, shown.map((m) => m.key)]) === before) return;
    const a = document.activeElement;
    const card = a && a.closest ? a.closest('[data-meal]') : null;
    const sel = card ? ['.dish-btn', '.link-btn', '.add-btn'].find((s) => a.matches(s)) : null;
    render(card && sel ? { meal: card.dataset.meal, sel } : null);
    if (card && sel && !document.activeElement.closest('[data-meal]')) {
      // the dish changed shape (e.g. added or cleared by Claude): focus whatever that card has now
      const other = document.querySelector('[data-meal="' + card.dataset.meal + '"] button');
      if (other) other.focus();
    }
  }
  setInterval(refresh, POLL_MS);
  document.addEventListener('visibilitychange', refresh);
})();
