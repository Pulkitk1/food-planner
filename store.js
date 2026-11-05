// Storage: Postgres when DATABASE_URL is set, otherwise a local data.json file.
//
// A workspace's plan is keyed by calendar date:
//   { "2026-11-05": { breakfast: Slot|null, lunch: Slot|null, dinner: Slot|null }, ... }
//   Slot = { name, nutrition: {calories, protein, carbs, fat, fibre}|null, eaten?: boolean }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Secret for the workspace's MCP link (/mcp/:token). Separate from the workspace
// key so it can be reset without changing the app's URL.
const newMcpToken = () => crypto.randomBytes(24).toString('base64url');

const MEALS = ['breakfast', 'lunch', 'dinner'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // Date#getDay() order

const pad = (x) => String(x).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const n = (calories, protein, carbs, fat, fibre) => ({ calories, protein, carbs, fat, fibre });

// Sample week (by weekday) used to seed new workspaces. Some meals are empty and
// some dishes have no nutrition, on purpose.
function sampleWeek() {
  const w = {};
  for (const d of WEEKDAYS) w[d] = { breakfast: null, lunch: null, dinner: null };
  const set = (day, meal, name, nutrition) => { w[day][meal] = { name, nutrition: nutrition || null }; };
  set('mon', 'breakfast', 'Poha', n(250, 6, 45, 6, 3));
  set('mon', 'lunch', 'Rajma chawal', n(420, 15, 70, 8, 11));
  set('mon', 'dinner', 'Dal chawal', n(380, 14, 65, 6, 8));
  set('tue', 'breakfast', 'Besan chilla', n(280, 14, 30, 11, 5));
  set('tue', 'lunch', 'Paneer bhurji with roti', n(480, 24, 40, 24, 5));
  set('tue', 'dinner', 'Vegetable khichdi', n(350, 12, 58, 8, 7));
  set('wed', 'breakfast', 'Upma', n(260, 6, 42, 8, 3));
  set('wed', 'lunch', 'Chole with rice', n(450, 16, 72, 10, 12));
  set('thu', 'breakfast', 'Masala oats', n(230, 8, 38, 5, 6));
  set('thu', 'lunch', 'Egg curry with roti');
  set('thu', 'dinner', 'Palak dal with jeera rice', n(400, 16, 62, 9, 9));
  set('fri', 'breakfast', 'Idli sambar', n(300, 10, 55, 4, 6));
  set('fri', 'lunch', 'Chicken curry with rice', n(560, 32, 60, 18, 3));
  set('fri', 'dinner', 'Moong dal cheela', n(290, 16, 34, 8, 6));
  set('sat', 'breakfast', 'Aloo paratha with curd', n(420, 11, 55, 17, 5));
  set('sat', 'lunch', 'Veg pulao with raita');
  set('sun', 'breakfast', 'Poha', n(250, 6, 45, 6, 3));
  set('sun', 'lunch', 'Rajma chawal', n(420, 15, 70, 8, 11));
  set('sun', 'dinner', 'Tomato soup and toast', n(260, 8, 40, 7, 4));
  return w;
}

// Old format: plan keyed by weekday (mon..sun).
function isWeeklyPlan(plan) {
  return !!plan && WEEKDAYS.some((d) => Object.prototype.hasOwnProperty.call(plan, d));
}

// Turns a weekday plan into dated plan: 21 days starting 2 days before today
// (server's local date), each date taking the dish planned for its weekday.
function weeklyToDated(weekly, today = new Date()) {
  const plan = {};
  for (let i = -2; i < 19; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const day = weekly[WEEKDAYS[d.getDay()]] || {};
    const out = {};
    for (const meal of MEALS) {
      const dish = day[meal];
      out[meal] = dish && dish.name ? { name: dish.name, nutrition: dish.nutrition || null } : null;
    }
    plan[ymd(d)] = out;
  }
  return plan;
}

const samplePlan = () => weeklyToDated(sampleWeek());

function makeFileStore(file) {
  let cache = null;
  const load = () => {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cache = { workspaces: {} }; }
    return cache;
  };
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  // Write to a temp file, then rename it over the real one. On Windows the rename
  // can fail briefly (EPERM/EBUSY) when antivirus, an indexer or an editor has the
  // file open, so retry, and as a last resort write the file in place.
  const save = () => {
    const json = JSON.stringify(cache, null, 2);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, json);
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        if (attempt >= 5) {
          fs.writeFileSync(file, json);
          try { fs.unlinkSync(tmp); } catch { /* already gone */ }
          return;
        }
        sleepSync(25 * (attempt + 1));
      }
    }
  };
  return {
    kind: 'data.json',
    async init() {
      const data = load();
      const legacy = Object.values(data.workspaces).filter((ws) => isWeeklyPlan(ws.plan));
      if (legacy.length) {
        try { fs.copyFileSync(file, file + '.bak'); } catch { /* nothing to back up */ }
        for (const ws of legacy) ws.plan = weeklyToDated(ws.plan);
        console.log(`Migrated ${legacy.length} workspace(s) from weekday plans to dated plans (backup: ${path.basename(file)}.bak)`);
      }
      const noToken = Object.values(data.workspaces).filter((ws) => !ws.mcpToken);
      for (const ws of noToken) ws.mcpToken = newMcpToken();
      if (legacy.length || noToken.length) save();
    },
    async createWorkspace(key, plan) {
      load().workspaces[key] = {
        plan, mcpLastSeen: null, createdAt: new Date().toISOString(),
        mcpToken: newMcpToken(), profile: null, profileSaved: false, onboarded: false, kitchen: [],
      };
      save();
    },
    // Merges top-level fields (profile, profileSaved, onboarded) into the workspace.
    async updateMeta(key, patch) {
      const ws = await this.getWorkspace(key);
      if (!ws) return false;
      const before = {};
      for (const k of Object.keys(patch)) before[k] = ws[k];
      Object.assign(ws, patch);
      try { save(); } catch (e) { Object.assign(ws, before); throw e; }
      return true;
    },
    // New MCP token; the old link stops working and "connected" resets.
    async resetMcpToken(key) {
      const ws = await this.getWorkspace(key);
      if (!ws) return null;
      const before = { mcpToken: ws.mcpToken, mcpLastSeen: ws.mcpLastSeen };
      ws.mcpToken = newMcpToken();
      ws.mcpLastSeen = null;
      try { save(); } catch (e) { Object.assign(ws, before); throw e; }
      return ws.mcpToken;
    },
    async keyForMcpToken(token) {
      const all = load().workspaces;
      return Object.keys(all).find((k) => all[k].mcpToken === token) || null;
    },
    // Removes the workspace for good (and from the one-time migration backup, if present).
    async deleteWorkspace(key) {
      const all = load().workspaces;
      if (!Object.prototype.hasOwnProperty.call(all, key)) return false;
      const ws = all[key];
      delete all[key];
      try { save(); } catch (e) { all[key] = ws; throw e; }
      const bak = file + '.bak';
      try {
        const b = JSON.parse(fs.readFileSync(bak, 'utf8'));
        if (b.workspaces && Object.prototype.hasOwnProperty.call(b.workspaces, key)) {
          delete b.workspaces[key];
          fs.writeFileSync(bak, JSON.stringify(b, null, 2));
        }
      } catch { /* no backup file */ }
      return true;
    },
    async getWorkspace(key) {
      const ws = load().workspaces;
      return Object.prototype.hasOwnProperty.call(ws, key) ? ws[key] : null;
    },
    // Returns that date's meals ({breakfast, lunch, dinner}) or null if no workspace.
    async setMeal(key, date, meal, slot) {
      const ws = await this.getWorkspace(key);
      if (!ws) return null;
      const before = ws.plan[date] ? { ...ws.plan[date] } : undefined;
      if (!ws.plan[date]) ws.plan[date] = { breakfast: null, lunch: null, dinner: null };
      ws.plan[date][meal] = slot;
      try {
        save();
      } catch (e) { // keep memory in step with disk if the write failed
        if (before) ws.plan[date] = before; else delete ws.plan[date];
        throw e;
      }
      return ws.plan[date];
    },
    // Applies several slot changes in one write: [{ date, meal, slot }]. All or nothing.
    async setMeals(key, changes) {
      const ws = await this.getWorkspace(key);
      if (!ws) return false;
      const before = {};
      for (const c of changes) {
        if (!(c.date in before)) before[c.date] = ws.plan[c.date] ? { ...ws.plan[c.date] } : undefined;
        if (!ws.plan[c.date]) ws.plan[c.date] = { breakfast: null, lunch: null, dinner: null };
        ws.plan[c.date][c.meal] = c.slot;
      }
      try {
        save();
      } catch (e) {
        for (const [d, v] of Object.entries(before)) { if (v) ws.plan[d] = v; else delete ws.plan[d]; }
        throw e;
      }
      return true;
    },
    async markMcp(key) {
      const ws = await this.getWorkspace(key);
      if (!ws) return false;
      ws.mcpLastSeen = new Date().toISOString();
      save();
      return true;
    },
  };
}

function makePgStore(url) {
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: local || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  });
  // meta holds { profile, profileSaved, onboarded, settings, kitchen }.
  const toWs = (r) => r && {
    plan: r.plan, mcpLastSeen: r.mcp_last_seen, createdAt: r.created_at, mcpToken: r.mcp_token,
    profile: (r.meta && r.meta.profile) || null,
    profileSaved: !!(r.meta && r.meta.profileSaved),
    onboarded: !!(r.meta && r.meta.onboarded),
    settings: (r.meta && r.meta.settings) || null,
    kitchen: (r.meta && r.meta.kitchen) || [],
  };
  return {
    kind: 'postgres',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS workspaces (
        key TEXT PRIMARY KEY,
        plan JSONB NOT NULL,
        mcp_last_seen TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await pool.query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS mcp_token TEXT');
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS workspaces_mcp_token ON workspaces (mcp_token)');
      const missing = await pool.query('SELECT key FROM workspaces WHERE mcp_token IS NULL');
      for (const r of missing.rows) await pool.query('UPDATE workspaces SET mcp_token = $2 WHERE key = $1', [r.key, newMcpToken()]);
      const { rows } = await pool.query('SELECT key, plan FROM workspaces');
      let migrated = 0;
      for (const r of rows) {
        if (!isWeeklyPlan(r.plan)) continue;
        await pool.query('UPDATE workspaces SET plan = $2 WHERE key = $1', [r.key, weeklyToDated(r.plan)]);
        migrated++;
      }
      if (migrated) console.log(`Migrated ${migrated} workspace(s) from weekday plans to dated plans`);
    },
    async createWorkspace(key, plan) {
      await pool.query('INSERT INTO workspaces (key, plan, mcp_token) VALUES ($1, $2, $3)', [key, plan, newMcpToken()]);
    },
    async updateMeta(key, patch) {
      const r = await pool.query('UPDATE workspaces SET meta = meta || $2::jsonb WHERE key = $1', [key, JSON.stringify(patch)]);
      return r.rowCount > 0;
    },
    async resetMcpToken(key) {
      const token = newMcpToken();
      const r = await pool.query('UPDATE workspaces SET mcp_token = $2, mcp_last_seen = NULL WHERE key = $1', [key, token]);
      return r.rowCount > 0 ? token : null;
    },
    async keyForMcpToken(token) {
      const { rows } = await pool.query('SELECT key FROM workspaces WHERE mcp_token = $1', [token]);
      return rows[0] ? rows[0].key : null;
    },
    async deleteWorkspace(key) {
      const r = await pool.query('DELETE FROM workspaces WHERE key = $1', [key]);
      return r.rowCount > 0;
    },
    async getWorkspace(key) {
      const { rows } = await pool.query('SELECT * FROM workspaces WHERE key = $1', [key]);
      return toWs(rows[0]);
    },
    async setMeal(key, date, meal, slot) {
      // date and meal are validated before this is called. The date object is
      // created on first use, then the meal is merged into it.
      const { rows } = await pool.query(
        `UPDATE workspaces
            SET plan = jsonb_set(plan, ARRAY[$2::text],
                  COALESCE(plan -> $2::text, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb), true)
          WHERE key = $1
      RETURNING plan -> $2::text AS day`,
        [key, date, meal, JSON.stringify(slot)]
      );
      return rows[0] ? rows[0].day : null;
    },
    async setMeals(key, changes) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const c of changes) {
          const r = await client.query(
            `UPDATE workspaces
                SET plan = jsonb_set(plan, ARRAY[$2::text],
                      COALESCE(plan -> $2::text, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb), true)
              WHERE key = $1`,
            [key, c.date, c.meal, JSON.stringify(c.slot)]
          );
          if (r.rowCount === 0) { await client.query('ROLLBACK'); return false; }
        }
        await client.query('COMMIT');
        return true;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async markMcp(key) {
      const r = await pool.query('UPDATE workspaces SET mcp_last_seen = now() WHERE key = $1', [key]);
      return r.rowCount > 0;
    },
  };
}

const store = process.env.DATABASE_URL
  ? makePgStore(process.env.DATABASE_URL)
  : makeFileStore(process.env.DATA_FILE || path.join(__dirname, 'data.json'));

module.exports = { store, MEALS, samplePlan };
