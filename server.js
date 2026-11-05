// Food Planner server.
// There is NO AI in this app: no model API keys, no model calls. The app only
// saves, shows and edits data. Users connect their own Claude through MCP.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { renderPage, THEME_SCRIPT, ICON_TAGS } = require('./layout');
const { store, MEALS, samplePlan } = require('./store');
const { emptyProfile, applyProfileFields } = require('./profile-schema');
const { mountMcp } = require('./mcp');
const kitchen = require('./kitchen-list');
const PLAN = require('./plan-config');

const app = express();
app.disable('x-powered-by');
// Behind a hosting proxy (Render, Railway, ...) use X-Forwarded-Proto/Host to build the MCP link.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '50kb', strict: false }));
app.use(express.urlencoded({ extended: false, limit: '2kb' })); // the start page form (invite code)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const NUTRIENTS = ['calories', 'protein', 'carbs', 'fat', 'fibre'];
const MAX_RANGE_DAYS = 400;
const page = (name) => path.join(__dirname, 'public', name);
// Standalone pages (start, not found) get the same theme script as the shared layout.
const themed = (name) => fs.readFileSync(page(name), 'utf8').replace('<!--THEME-->', `${ICON_TAGS}\n  <script>${THEME_SCRIPT}</script>`);
const START_HTML = themed('index.html')
  .replace(/\{\{TRIAL_DAYS\}\}/g, String(PLAN.TRIAL_DAYS))
  .replace(/\{\{PRICE_LAUNCH\}\}/g, String(PLAN.PRICE_LAUNCH))
  .replace(/\{\{PRICE_YEARLY_LAUNCH\}\}/g, String(PLAN.PRICE_YEARLY_LAUNCH));
const DELETED_NOTICE = '<p class="notice" role="status">Your data has been deleted.</p>';
const NOT_FOUND_HTML = themed('notfound.html');
const sendNotFound = (res) => res.status(404).type('html').send(NOT_FOUND_HTML);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function findWorkspace(key) {
  return KEY_RE.test(key) ? store.getWorkspace(key) : null;
}

// Full MCP link for a workspace. Set BASE_URL (e.g. https://food.example.com)
// when the app is hosted, so the link is right even behind proxies.
// PUBLIC_URL is still accepted as an older name.
function baseUrl(req) {
  const configured = process.env.BASE_URL || process.env.PUBLIC_URL;
  return configured ? configured.replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`;
}
function mcpUrl(req, token) {
  return `${baseUrl(req)}/mcp/${token}`;
}

// Invite codes: 8 random letters/digits, unrelated to the workspace key.
const INVITE_RE = /^[A-Za-z0-9]{8}$/;
const INVITE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
async function newInviteCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 8; i++) code += INVITE_CHARS[crypto.randomInt(INVITE_CHARS.length)];
    if (!(await store.keyForInviteCode(code))) return code;
  }
}

const profileOf = (ws) => ({ ...emptyProfile(), ...(ws.profile || {}) });
// Workspace settings. meals: which meals the app shows (all on by default).
const settingsOf = (ws) => ({
  meals: { breakfast: true, lunch: true, dinner: true, ...((ws.settings && ws.settings.meals) || {}) },
});
// First-run flow shows until the profile has been saved once or the flow is finished/skipped.
const needsOnboarding = (ws) => !ws.onboarded && !ws.profileSaved;

// YYYY-MM-DD that is a real calendar date.
function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const year = Number(s.slice(0, 4));
  if (year < 2000 || year > 2100) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Builds the slot to store from a PUT body, merged onto the existing slot (if any).
// Fields left out keep their current value, so { nutrition: null } only clears nutrition.
// nutrition: null clears it. Nutrition, when present, must include calories.
function buildSlot(body, existing) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Body must be a JSON object' };

  let name = existing ? existing.name : '';
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return { error: 'name must be text' };
    name = body.name.trim();
  }
  if (!name) return { error: 'Dish needs a name' };
  if (name.length > 120) return { error: 'Dish name is too long (max 120 characters)' };

  let nutrition = existing && existing.nutrition ? existing.nutrition : null;
  if (body.nutrition !== undefined) {
    if (body.nutrition === null) {
      nutrition = null;
    } else {
      if (typeof body.nutrition !== 'object' || Array.isArray(body.nutrition)) return { error: 'nutrition must be an object or null' };
      const next = {};
      for (const k of NUTRIENTS) {
        const v = body.nutrition[k];
        if (v == null || v === '') { next[k] = null; continue; }
        const num = Number(v);
        if (!Number.isFinite(num) || num < 0 || num > 10000) return { error: `nutrition.${k} must be a number from 0 to 10000` };
        next[k] = Math.round(num * 10) / 10;
      }
      if (NUTRIENTS.every((k) => next[k] == null)) nutrition = null;
      else if (next.calories == null) return { error: 'nutrition needs calories (or send nutrition: null)' };
      else nutrition = next;
    }
  }

  // Keep the eaten flag Claude may have set (set_eaten) when the user edits the dish.
  return { slot: { name, nutrition, ...(existing && existing.eaten ? { eaten: true } : {}) } };
}

// Pages
app.get('/', (req, res) => {
  // ?ref=CODE from an invite link goes into a hidden form field only; it is never shown.
  const ref = typeof req.query.ref === 'string' && INVITE_RE.test(req.query.ref) ? req.query.ref : '';
  res.type('html').send(START_HTML
    .replace('<!--NOTICE-->', req.query.deleted === '1' ? DELETED_NOTICE : '')
    .replace('<!--REF-->', ref ? `<input type="hidden" name="ref" value="${ref}">` : ''));
});

// Invite link: send people to the start page. Never reveals whose code it is.
app.get('/invite/:code', wrap(async (req, res) => {
  const { code } = req.params;
  const known = INVITE_RE.test(code) && (await store.keyForInviteCode(code));
  res.redirect(302, known ? `/?ref=${code}` : '/');
}));

app.post('/start', wrap(async (req, res) => {
  const key = crypto.randomBytes(18).toString('base64url');
  await store.createWorkspace(key, samplePlan());
  const ref = req.body && typeof req.body.ref === 'string' ? req.body.ref : '';
  if (INVITE_RE.test(ref) && (await store.keyForInviteCode(ref))) {
    await store.updateMeta(key, { referredBy: ref }); // stored only; nothing else uses it yet
  }
  res.redirect(303, `/w/${key}`);
}));

// View fragments; "{{key}}" is replaced with the (validated) workspace key.
const view = (name) => fs.readFileSync(path.join(__dirname, 'views', name), 'utf8');

// Workspace pages, all rendered through the shared layout.
// The id is the path after /w/:key; "active" is the highlighted sidebar tab.
const SCREENS = {
  '': { active: 'home', title: 'Today', content: view('home.html'), scripts: ['/home.js', '/home-trial.js'] },
  planner: { active: 'planner', title: 'Planner', content: view('planner.html'), scripts: ['/planner.js'] },
  kitchen: { active: 'kitchen', title: 'My Kitchen', content: view('kitchen.html'), scripts: ['/profile-fields.js', '/kitchen.js'] },
  profile: { active: 'profile', title: 'Profile', content: view('profile.html'), scripts: ['/profile-fields.js', '/profile.js'] },
  'profile/settings': { active: 'profile', title: 'Settings', content: view('settings.html'), scripts: ['/settings.js'] },
  welcome: { active: null, bare: true, title: 'Welcome', content: view('welcome.html'), scripts: ['/profile-fields.js', '/welcome.js'] },
};

app.get(['/w/:key', '/w/:key/:screen', '/w/:key/:screen/:sub'], wrap(async (req, res, next) => {
  const id = [req.params.screen, req.params.sub].filter(Boolean).join('/');
  if (!Object.prototype.hasOwnProperty.call(SCREENS, id)) return next();
  const screen = SCREENS[id];
  const { key } = req.params;
  const ws = await findWorkspace(key);
  if (!ws) return sendNotFound(res);
  if (id === '' && needsOnboarding(ws)) return res.redirect(302, `/w/${key}/welcome`);
  if (id === 'welcome' && ws.onboarded) return res.redirect(302, `/w/${key}`);
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderPage({ key, ...screen, content: screen.content.split('{{key}}').join(key) }));
}));

// API
// GET /api/:key/plan?from=YYYY-MM-DD&to=YYYY-MM-DD  (both optional; omit for everything)
app.get('/api/:key/plan', wrap(async (req, res) => {
  const ws = await findWorkspace(req.params.key);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  const { from, to } = req.query;
  if (from !== undefined && !isDate(from)) return res.status(400).json({ error: 'from must be a date like 2026-11-05' });
  if (to !== undefined && !isDate(to)) return res.status(400).json({ error: 'to must be a date like 2026-11-05' });
  if (from && to) {
    if (from > to) return res.status(400).json({ error: 'from must not be after to' });
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_RANGE_DAYS) {
      return res.status(400).json({ error: `Range is too long (max ${MAX_RANGE_DAYS} days)` });
    }
  }
  const plan = {};
  for (const date of Object.keys(ws.plan).sort()) {
    if ((from && date < from) || (to && date > to)) continue;
    plan[date] = ws.plan[date];
  }
  res.set('Cache-Control', 'no-store');
  res.json({ plan, settings: settingsOf(ws), claudeConnected: !!ws.mcpLastSeen, mcpLastSeen: ws.mcpLastSeen });
}));

// Checks :date and :meal and loads the workspace. Sends the error response and
// returns null when something is wrong.
async function slotTarget(req, res) {
  const { key, date, meal } = req.params;
  if (!isDate(date)) { res.status(400).json({ error: 'date must be a date like 2026-11-05' }); return null; }
  if (!MEALS.includes(meal)) { res.status(400).json({ error: `meal must be one of: ${MEALS.join(', ')}` }); return null; }
  const ws = await findWorkspace(key);
  if (!ws) { res.status(404).json({ error: 'Workspace not found' }); return null; }
  return { key, date, meal, existing: (ws.plan[date] && ws.plan[date][meal]) || null };
}

// Set or update a slot. Body: { name?, nutrition? } (name required for a new slot).
app.put('/api/:key/plan/:date/:meal', wrap(async (req, res) => {
  const t = await slotTarget(req, res);
  if (!t) return;
  const built = buildSlot(req.body, t.existing);
  if (built.error) return res.status(400).json({ error: built.error });
  await store.setMeal(t.key, t.date, t.meal, built.slot);
  res.json({ date: t.date, meal: t.meal, dish: built.slot });
}));

// Clear a slot.
app.delete('/api/:key/plan/:date/:meal', wrap(async (req, res) => {
  const t = await slotTarget(req, res);
  if (!t) return;
  await store.setMeal(t.key, t.date, t.meal, null);
  res.json({ date: t.date, meal: t.meal, dish: null });
}));

// Profile
app.get('/api/:key/profile', wrap(async (req, res) => {
  const ws = await findWorkspace(req.params.key);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  res.set('Cache-Control', 'no-store');
  res.json({
    profile: profileOf(ws),
    profileSaved: !!ws.profileSaved,
    onboarded: !!ws.onboarded,
    claudeConnected: !!ws.mcpLastSeen,
    mcpUrl: mcpUrl(req, ws.mcpToken),
  });
}));

// Saves the whole profile (fields left out are reset to empty).
app.put('/api/:key/profile', wrap(async (req, res) => {
  if (!(await findWorkspace(req.params.key))) return res.status(404).json({ error: 'Workspace not found' });
  const result = applyProfileFields(req.body, emptyProfile());
  if (result.error) return res.status(400).json({ error: result.error });
  await store.updateMeta(req.params.key, { profile: result.profile, profileSaved: true });
  res.json({ profile: result.profile });
}));

// Marks the first-run flow as finished (or skipped) so it doesn't show again.
app.post('/api/:key/onboarding', wrap(async (req, res) => {
  if (!(await findWorkspace(req.params.key))) return res.status(404).json({ error: 'Workspace not found' });
  await store.updateMeta(req.params.key, { onboarded: true });
  res.json({ onboarded: true });
}));

// New MCP link; the old one stops working at once.
app.post('/api/:key/mcp-link/reset', wrap(async (req, res) => {
  if (!(await findWorkspace(req.params.key))) return res.status(404).json({ error: 'Workspace not found' });
  const token = await store.resetMcpToken(req.params.key);
  res.json({ mcpUrl: mcpUrl(req, token), claudeConnected: false });
}));

// Kitchen list (newest first)
app.get('/api/:key/kitchen', wrap(async (req, res) => {
  const ws = await findWorkspace(req.params.key);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  res.set('Cache-Control', 'no-store');
  res.json({ items: kitchen.listOf(ws) });
}));

// Body: { name, addedAt? }. addedAt is only used by Undo to put an item back in place.
// A duplicate (ignoring case) is not added: { item: null, duplicate: true }.
app.post('/api/:key/kitchen', wrap(async (req, res) => {
  const ws = await findWorkspace(req.params.key);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  const body = req.body || {};
  const name = kitchen.cleanName(body.name);
  if (!name) return res.status(400).json({ error: 'Ingredient needs a name' });
  if (name.length > kitchen.MAX_NAME_LEN) return res.status(400).json({ error: `Keep names to ${kitchen.MAX_NAME_LEN} characters` });
  let addedAt;
  if (body.addedAt !== undefined) {
    const t = Date.parse(body.addedAt);
    if (typeof body.addedAt !== 'string' || Number.isNaN(t) || t > Date.now() + 60000) return res.status(400).json({ error: 'addedAt must be a past ISO time' });
    addedAt = new Date(t).toISOString();
  }
  const r = kitchen.addNames(kitchen.listOf(ws), [name], addedAt);
  if (r.invalid.length) return res.status(400).json({ error: `Your kitchen list is full (${kitchen.MAX_ITEMS} items)` });
  if (r.skipped.length) return res.json({ item: null, duplicate: true, items: kitchen.listOf(ws) });
  await store.updateMeta(req.params.key, { kitchen: r.list });
  res.status(201).json({ item: r.list.find((i) => i.name === name), duplicate: false, items: r.list });
}));

app.delete('/api/:key/kitchen/:id', wrap(async (req, res) => {
  const ws = await findWorkspace(req.params.key);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  const list = kitchen.listOf(ws);
  const item = list.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const rest = list.filter((i) => i !== item);
  await store.updateMeta(req.params.key, { kitchen: rest });
  res.json({ removed: item, items: rest });
}));

// Plan / trial (display only: nothing is locked when the trial ends, no payments yet).
const DAY_MS = 24 * 60 * 60 * 1000;
const localYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function trialInfo(createdAt, now = new Date()) {
  const created = new Date(createdAt);
  const elapsed = Math.max(0, Math.floor((now - created) / DAY_MS)); // full days since sign-up
  const days = PLAN.TRIAL_DAYS;
  return {
    createdAt: created.toISOString(),
    trialDays: days,
    trialDay: Math.min(Math.max(elapsed + 1, 1), Math.max(days, 1)),
    trialDaysLeft: Math.max(0, days - elapsed),
    trialEnded: elapsed >= days,
    trialEndsOn: localYmd(new Date(created.getTime() + days * DAY_MS)),
    priceLaunch: PLAN.PRICE_LAUNCH,
    priceLater: PLAN.PRICE_LATER,
    ...yearlyInfo(),
  };
}

// Yearly figures are worked out from the config, never typed in.
function yearlyInfo() {
  return {
    priceYearlyLaunch: PLAN.PRICE_YEARLY_LAUNCH,
    priceYearlyLater: PLAN.PRICE_YEARLY_LATER,
    yearlyPerMonth: Math.round(PLAN.PRICE_YEARLY_LAUNCH / 12),
    yearlySavingPct: Math.round((1 - PLAN.PRICE_YEARLY_LAUNCH / (12 * PLAN.PRICE_LAUNCH)) * 100),
  };
}

app.get('/api/:key/subscription', wrap(async (req, res) => {
  const ws = await findWorkspace(req.params.key);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  let createdAt = ws.createdAt;
  if (!createdAt || Number.isNaN(new Date(createdAt).getTime())) {
    // Older workspaces without a date: start their trial now, and remember it.
    createdAt = new Date().toISOString();
    await store.updateMeta(req.params.key, { createdAt });
  }
  res.set('Cache-Control', 'no-store');
  res.json(trialInfo(createdAt));
}));

// Invite link for sharing. The code is created the first time it's needed.
app.get('/api/:key/invite', wrap(async (req, res) => {
  const ws = await findWorkspace(req.params.key);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  let code = ws.inviteCode;
  if (!code || !INVITE_RE.test(code)) {
    code = await newInviteCode();
    await store.updateMeta(req.params.key, { inviteCode: code });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ inviteUrl: `${baseUrl(req)}/invite/${code}`, trialDays: PLAN.TRIAL_DAYS });
}));

// Settings
app.get('/api/:key/settings', wrap(async (req, res) => {
  const ws = await findWorkspace(req.params.key);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  res.set('Cache-Control', 'no-store');
  res.json({ settings: settingsOf(ws) });
}));

// Body: { meals: { breakfast?: bool, lunch?: bool, dinner?: bool } }. At least one meal stays on.
app.put('/api/:key/settings', wrap(async (req, res) => {
  const ws = await findWorkspace(req.params.key);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  const body = req.body;
  if (!body || typeof body !== 'object' || !body.meals || typeof body.meals !== 'object' || Array.isArray(body.meals)) {
    return res.status(400).json({ error: 'Send { meals: { breakfast, lunch, dinner } }' });
  }
  const meals = settingsOf(ws).meals;
  for (const [k, v] of Object.entries(body.meals)) {
    if (!MEALS.includes(k)) return res.status(400).json({ error: `Unknown meal: ${k}` });
    if (typeof v !== 'boolean') return res.status(400).json({ error: `${k} must be true or false` });
    meals[k] = v;
  }
  if (!MEALS.some((m) => meals[m])) return res.status(400).json({ error: 'Keep at least one meal on.' });
  const settings = { ...(ws.settings || {}), meals };
  await store.updateMeta(req.params.key, { settings });
  res.json({ settings: settingsOf({ settings }) });
}));

// Everything stored for the workspace, as a download. The Claude link itself is
// left out: it's a secret, and it is reset if ever needed.
app.get('/api/:key/export', wrap(async (req, res) => {
  const ws = await findWorkspace(req.params.key);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  const plan = {};
  for (const date of Object.keys(ws.plan).sort()) plan[date] = ws.plan[date];
  const data = {
    app: 'Food Planner',
    exportedAt: new Date().toISOString(),
    createdAt: ws.createdAt || null,
    profile: profileOf(ws),
    kitchen: kitchen.listOf(ws),
    plan,
    settings: settingsOf(ws),
  };
  res.set('Cache-Control', 'no-store');
  res.set('Content-Disposition', 'attachment; filename="food-planner-export.json"');
  res.type('application/json').send(JSON.stringify(data, null, 2));
}));

// Deletes the workspace and everything in it. The MCP link stops working with it.
app.delete('/api/:key', wrap(async (req, res) => {
  if (!KEY_RE.test(req.params.key) || !(await store.deleteWorkspace(req.params.key))) {
    return res.status(404).json({ error: 'Workspace not found' });
  }
  res.json({ deleted: true });
}));

mountMcp(app, store);

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    if (req.path.startsWith('/mcp/')) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;
store.init()
  .then(() => app.listen(PORT, () => console.log(`Food Planner running at http://localhost:${PORT} (storage: ${store.kind})`)))
  .catch((e) => { console.error('Could not start storage:', e.message); process.exit(1); });
