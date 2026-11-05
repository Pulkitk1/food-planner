// Shared profile components used by the Profile page and the welcome flow:
// the five preference fields, the autosave, and the Claude link box.
(function () {
  'use strict';

  const DIETS = [
    { v: 'vegetarian', l: 'Vegetarian' }, { v: 'eggetarian', l: 'Eggetarian' },
    { v: 'non-vegetarian', l: 'Non-vegetarian' }, { v: 'vegan', l: 'Vegan' },
  ];
  const CUISINES = ['North Indian', 'South Indian', 'Punjabi', 'Gujarati', 'Maharashtrian', 'Bengali', 'Other']
    .map((c) => ({ v: c, l: c }));
  const TASTES = [{ v: 'mild', l: 'Mild' }, { v: 'normal', l: 'Normal' }, { v: 'spicy', l: 'Spicy' }];
  const ALLERGIES = [
    { v: 'peanuts', l: 'Peanuts' }, { v: 'dairy', l: 'Dairy' }, { v: 'gluten', l: 'Gluten' },
    { v: 'eggs', l: 'Eggs' }, { v: 'soy', l: 'Soy' }, { v: 'other', l: 'Other' },
  ];
  const SAVE_DELAY_MS = 500;
  const MAX_DISLIKES = 50;
  const MAX_DISLIKE_LEN = 40;

  let uid = 0;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const emptyProfile = () => ({ diet: null, cuisines: [], taste: null, dislikes: [], allergies: [], allergyNote: '' });
  const normalize = (p) => Object.assign(emptyProfile(), p || {});
  const same = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
  const svg = (paths, size) =>
    '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths + '</svg>';

  /**
   * createEditor({ key, onStatus(state) }) where state is 'saved' | 'error'.
   * editor.field(name) returns the element for diet | cuisines | taste | dislikes | allergies.
   */
  function createEditor(opts) {
    const key = opts.key;
    const onStatus = opts.onStatus || function () {};
    let profile = emptyProfile();
    const mounted = [];
    let timer = null;
    let saving = false;
    let dirty = false;

    function changed() {
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(save, SAVE_DELAY_MS);
    }

    async function save() {
      timer = null;
      if (saving || !dirty) return; // a save in flight will pick up new changes when it ends
      dirty = false;
      saving = true;
      let ok = false;
      try {
        const res = await fetch('/api/' + encodeURIComponent(key) + '/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profile),
        });
        ok = res.ok;
      } catch (_) { ok = false; }
      saving = false;
      if (!ok) {
        dirty = true; // keep the user's changes; the next change (or flush) tries again
        onStatus('error');
        return;
      }
      if (dirty) { if (!timer) save(); return; }
      onStatus('saved');
    }

    // Saves now if anything is waiting. Resolves true when everything is saved.
    async function flush() {
      clearTimeout(timer);
      timer = null;
      while (saving) await new Promise((r) => setTimeout(r, 40));
      if (dirty) await save();
      return !dirty;
    }

    function editingText() {
      const a = document.activeElement;
      return !!a && a.tagName === 'INPUT' && a.type === 'text' && mounted.some((m) => m.el.contains(a));
    }

    // Busy = the user is typing, or there are unsaved/in-flight changes.
    const busy = () => !!timer || saving || dirty || editingText();

    // Replace the profile with server data (skipped while busy unless forced).
    function setProfile(p, force) {
      if (!force && busy()) return false;
      if (same(p, profile)) return false;
      profile = normalize(JSON.parse(JSON.stringify(p)));
      mounted.forEach((m) => m.update());
      return true;
    }

    function mount(f) { mounted.push(f); f.update(); return f.el; }

    function fieldset(label, hint) {
      const fs = el('fieldset', 'pf-field');
      fs.append(el('legend', 'pf-label', label));
      if (hint) fs.append(el('p', 'pf-hint', hint));
      return fs;
    }

    // Chips: real buttons with aria-pressed.
    function choiceGroup(options, isOn, toggle, large) {
      const group = el('div', 'choice-group' + (large ? ' large' : ''));
      const buttons = options.map((o) => {
        const b = el('button', 'choice', o.l);
        b.type = 'button';
        b.addEventListener('click', () => { toggle(o.v); update(); changed(); });
        group.append(b);
        return [o.v, b];
      });
      function update() { buttons.forEach(([v, b]) => b.setAttribute('aria-pressed', String(isOn(v)))); }
      return { el: group, update };
    }

    const builders = {
      diet() {
        const fs = fieldset('Diet', 'Pick one. Tap again to clear.');
        const g = choiceGroup(DIETS, (v) => profile.diet === v, (v) => { profile.diet = profile.diet === v ? null : v; }, true);
        fs.append(g.el);
        return { el: fs, update: g.update };
      },
      cuisines() {
        const fs = fieldset('Favourite cuisines', 'Pick as many as you like.');
        const g = choiceGroup(CUISINES, (v) => profile.cuisines.includes(v), (v) => {
          profile.cuisines = profile.cuisines.includes(v)
            ? profile.cuisines.filter((x) => x !== v)
            : CUISINES.map((c) => c.v).filter((c) => c === v || profile.cuisines.includes(c));
        });
        fs.append(g.el);
        return { el: fs, update: g.update };
      },
      taste() {
        const fs = fieldset('Taste');
        const seg = el('div', 'segmented');
        const name = 'taste-' + (++uid);
        const radios = TASTES.map((o) => {
          const label = el('label');
          const input = el('input');
          input.type = 'radio';
          input.name = name;
          input.value = o.v;
          input.addEventListener('change', () => { if (input.checked) { profile.taste = o.v; changed(); } });
          label.append(input, el('span', null, o.l));
          seg.append(label);
          return input;
        });
        fs.append(seg);
        return { el: fs, update() { radios.forEach((r) => { r.checked = r.value === profile.taste; }); } };
      },
      dislikes() {
        const id = 'dislikes-' + (++uid);
        const wrap = el('div', 'pf-field');
        const label = el('label', 'pf-label', 'Ingredients I dislike');
        label.htmlFor = id;
        const hint = el('p', 'pf-hint', 'Type an ingredient and press Enter or comma to add it.');
        hint.id = id + '-hint';
        const box = el('div', 'tag-box');
        const list = el('ul', 'tag-list');
        list.setAttribute('aria-label', 'Disliked ingredients');
        const input = el('input');
        input.type = 'text';
        input.id = id;
        input.maxLength = MAX_DISLIKE_LEN;
        input.autocomplete = 'off';
        input.enterKeyHint = 'done';
        input.placeholder = 'e.g. karela';
        input.setAttribute('aria-describedby', hint.id);
        const msg = el('p', 'pf-hint tag-msg');
        msg.setAttribute('role', 'status');
        box.append(list, input);
        wrap.append(label, hint, box, msg);

        function render() {
          list.replaceChildren();
          profile.dislikes.forEach((name) => {
            const li = el('li', 'tag');
            li.append(el('span', null, name));
            const x = el('button', 'tag-x');
            x.type = 'button';
            x.setAttribute('aria-label', 'Remove ' + name);
            x.innerHTML = svg('<path d="M18 6 6 18M6 6l12 12"/>', 16);
            x.addEventListener('click', () => {
              profile.dislikes = profile.dislikes.filter((d) => d !== name);
              render();
              changed();
              msg.textContent = name + ' removed.';
              input.focus();
            });
            li.append(x);
            list.append(li);
          });
        }
        // Adds one name; returns true if it was added. Duplicates (any case) are ignored.
        function add(raw) {
          const name = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_DISLIKE_LEN);
          if (!name) return false;
          if (profile.dislikes.some((d) => d.toLowerCase() === name.toLowerCase())) {
            msg.textContent = name + ' is already in your list.';
            return false;
          }
          if (profile.dislikes.length >= MAX_DISLIKES) { msg.textContent = 'You can add up to ' + MAX_DISLIKES + ' ingredients.'; return false; }
          profile.dislikes = profile.dislikes.concat(name);
          msg.textContent = name + ' added.';
          return true;
        }
        function commit(values) {
          let added = false;
          values.forEach((v) => { if (add(v)) added = true; });
          if (added) { render(); changed(); }
        }
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit([input.value]);
            input.value = '';
          }
        });
        // Mobile keyboards often don't report the comma key, so also split on input.
        input.addEventListener('input', () => {
          if (!input.value.includes(',')) return;
          const parts = input.value.split(',');
          input.value = parts.pop();
          commit(parts);
        });
        input.addEventListener('blur', () => {
          if (input.value.trim()) { commit([input.value]); input.value = ''; }
        });
        return { el: wrap, update: render };
      },
      allergies() {
        const fs = fieldset('Allergies and restrictions', 'Claude is told to avoid these strictly.');
        const g = choiceGroup(ALLERGIES, (v) => profile.allergies.includes(v), (v) => {
          profile.allergies = profile.allergies.includes(v)
            ? profile.allergies.filter((x) => x !== v)
            : ALLERGIES.map((a) => a.v).filter((a) => a === v || profile.allergies.includes(a));
        });
        const id = 'allergy-note-' + (++uid);
        const noteWrap = el('div', 'field pf-note');
        const label = el('label', null, 'Anything else? (optional)');
        label.htmlFor = id;
        const note = el('input');
        note.type = 'text';
        note.id = id;
        note.maxLength = 300;
        note.autocomplete = 'off';
        note.placeholder = 'e.g. no mustard oil';
        note.addEventListener('input', () => { profile.allergyNote = note.value; changed(); });
        noteWrap.append(label, note);
        fs.append(g.el, noteWrap);
        return {
          el: fs,
          update() {
            g.update();
            if (document.activeElement !== note) note.value = profile.allergyNote || '';
          },
        };
      },
    };

    return {
      field(name) { return mount(builders[name]()); },
      setProfile,
      getProfile: () => JSON.parse(JSON.stringify(profile)),
      busy,
      flush,
    };
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fall back */ }
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

  // Read-only link box with a Copy button.
  function linkBox() {
    const id = 'mcp-link-' + (++uid);
    const wrap = el('div', 'field link-field');
    const label = el('label', null, 'Your private Claude link');
    label.htmlFor = id;
    const row = el('div', 'copy-row');
    const input = el('input', 'mono');
    input.type = 'text';
    input.id = id;
    input.readOnly = true;
    input.addEventListener('focus', () => input.select());
    const btn = el('button', 'btn', 'Copy');
    btn.type = 'button';
    const status = el('p', 'pf-hint copy-status');
    status.setAttribute('role', 'status');
    let t;
    btn.addEventListener('click', async () => {
      const ok = await copyText(input.value);
      clearTimeout(t);
      if (ok) {
        status.textContent = 'Copied';
        status.classList.remove('is-error');
        t = setTimeout(() => { status.textContent = ''; }, 2500);
      } else {
        input.focus();
        input.select();
        status.textContent = 'Couldn’t copy automatically. The link is selected: press Ctrl+C (or long-press and Copy).';
        status.classList.add('is-error');
      }
    });
    row.append(input, btn);
    wrap.append(label, row, status);
    return {
      el: wrap,
      copyButton: btn,
      setUrl(u) { if (input.value !== u) input.value = u; },
      getUrl: () => input.value,
    };
  }

  function connectSteps() {
    const ol = el('ol', 'steps');
    ['Copy your link.', 'In Claude, open Customize, then Connectors, then Add custom connector.', 'Paste the link and click Add.']
      .forEach((s) => ol.append(el('li', null, s)));
    return ol;
  }

  window.FPProfile = { createEditor, linkBox, connectSteps, emptyProfile, copyText };
})();
