// First-run flow: one question per screen, then "You're set".
// Uses the same fields and autosave as the Profile page.
(function () {
  'use strict';
  const key = location.pathname.split('/')[2];
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const QUESTIONS = [
    { field: 'diet', title: 'What do you eat?', sub: 'This helps Claude suggest the right dishes.' },
    { field: 'cuisines', title: 'Which cuisines do you enjoy?', sub: 'Pick a few favourites.' },
    { field: 'taste', title: 'How spicy do you like it?', sub: 'You can change this anytime.' },
    { field: 'dislikes', title: 'Anything you don’t like?', sub: 'Add ingredients you’d rather not eat.' },
    { field: 'allergies', title: 'Any allergies or restrictions?', sub: 'Claude is told never to include these.' },
  ];

  const status = $('save-status');
  const editor = FPProfile.createEditor({
    key,
    onStatus(state) {
      status.textContent = state === 'saved' ? 'Saved' : 'Couldn’t save. Check your connection and try again.';
      status.classList.toggle('is-error', state !== 'saved');
      if (state === 'saved') setTimeout(() => { if (status.textContent === 'Saved') status.textContent = ''; }, 2000);
    },
  });
  const link = FPProfile.linkBox();
  const screens = [];
  let current = 0;

  async function markDone() {
    await editor.flush();
    try { await fetch('/api/' + encodeURIComponent(key) + '/onboarding', { method: 'POST' }); } catch (_) { /* Home will just show this again */ }
  }
  async function goHome() {
    await markDone();
    location.href = '/w/' + encodeURIComponent(key);
  }

  function show(i) {
    current = i;
    screens.forEach((s, n) => { s.hidden = n !== i; });
    const done = i === QUESTIONS.length;
    $('progress-text').textContent = done ? 'All done' : 'Question ' + (i + 1) + ' of ' + QUESTIONS.length;
    $('progress-bar').style.width = (done ? 100 : (i / QUESTIONS.length) * 100) + '%';
    $('skip-setup').hidden = done;
    screens[i].querySelector('h1').focus(); // announce the new question
    if (done) markDone();
  }

  function questionScreen(q, i) {
    const sec = el('section', 'welcome-step');
    sec.hidden = true;
    const h = el('h1', null, q.title);
    h.tabIndex = -1;
    sec.append(h, el('p', 'eyebrow welcome-sub', q.sub), editor.field(q.field));
    const actions = el('div', 'welcome-actions');
    if (i > 0) {
      const back = el('button', 'btn btn-ghost', 'Back');
      back.type = 'button';
      back.addEventListener('click', () => show(i - 1));
      actions.append(back);
    }
    const skip = el('button', 'btn btn-ghost', 'Skip');
    skip.type = 'button';
    skip.addEventListener('click', () => show(i + 1));
    const next = el('button', 'btn', i === QUESTIONS.length - 1 ? 'Finish' : 'Next');
    next.type = 'button';
    next.addEventListener('click', () => show(i + 1));
    actions.append(skip, next);
    sec.append(actions);
    return sec;
  }

  function doneScreen() {
    const sec = el('section', 'welcome-step');
    sec.hidden = true;
    const h = el('h1', null, 'You’re set');
    h.tabIndex = -1;
    sec.append(h, el('p', 'eyebrow welcome-sub', 'Connect Claude so it can plan meals around your preferences.'));
    const panel = el('div', 'panel');
    panel.append(link.el, FPProfile.connectSteps());
    sec.append(panel);
    const actions = el('div', 'welcome-actions');
    const home = el('button', 'btn', 'Go to Home');
    home.type = 'button';
    home.addEventListener('click', goHome);
    actions.append(home);
    sec.append(actions, el('p', 'pf-hint', 'You can change your preferences anytime in Profile.'));
    return sec;
  }

  $('skip-setup').addEventListener('click', goHome);

  fetch('/api/' + encodeURIComponent(key) + '/profile', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
    .then((data) => {
      editor.setProfile(data.profile, true);
      link.setUrl(data.mcpUrl);
      QUESTIONS.forEach((q, i) => screens.push(questionScreen(q, i)));
      screens.push(doneScreen());
      $('steps').replaceChildren(...screens);
      show(0);
    })
    .catch(() => {
      $('steps').replaceChildren(el('p', 'error', 'Could not load. Check your connection and refresh.'));
    });

  // Don't lose a pending save if the tab is closed mid-flow.
  window.addEventListener('pagehide', () => { editor.flush(); });
})();
