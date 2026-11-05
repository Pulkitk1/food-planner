// MCP tools for the meal plan: get_plan, set_meal, set_meals, fill_nutrition,
// clear_meal, set_eaten. No AI here: Claude decides what to cook; these tools only
// check and store what Claude sends, and report back what changed.

const MEALS = ['breakfast', 'lunch', 'dinner'];
const MEAL_PLURAL = { breakfast: 'breakfasts', lunch: 'lunches', dinner: 'dinners' };
const LIMITS = { calories: 5000, protein: 500, carbs: 500, fat: 500, fibre: 500 }; // kcal / grams
const NUTRIENTS = Object.keys(LIMITS);
const MAX_DISH_LEN = 100;
const MAX_DAYS = 31;
const MAX_BATCH = 21;
const MAX_FILL = 63;

class InputError extends Error {}
const bad = (msg) => { throw new InputError(msg); };

// ---------- dates ----------
const pad = (x) => String(x).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayYmd = () => ymd(new Date());
function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const year = Number(s.slice(0, 4));
  if (year < 2000 || year > 2100) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const utc = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = (s) => utc(s).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
const shortDay = (s) => `${weekday(s)} ${utc(s).getUTCDate()}`;
const longDay = (s) => `${shortDay(s)} ${utc(s).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}`;

// ---------- input checks (friendly messages so Claude can fix the call) ----------
function checkFields(obj, allowed, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) bad(`${where} must be an object.`);
  const hints = { name: 'dish', dish_name: 'dish', kcal: 'calories', fiber: 'fibre', day: 'date', slot: 'meal', mealType: 'meal' };
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) bad(`${where}: unknown field "${k}".${hints[k] ? ` Did you mean "${hints[k]}"?` : ''} Allowed: ${allowed.join(', ')}.`);
  }
}
function parseDate(v, field = 'date') {
  if (v === undefined || v === null || v === '') bad(`${field} is missing. Use YYYY-MM-DD, like ${todayYmd()}.`);
  if (!isDate(v)) bad(`${field} "${v}" isn't a valid date. Use YYYY-MM-DD, like ${todayYmd()}.`);
  return v;
}
function parseMeal(v) {
  const m = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!MEALS.includes(m)) bad(`meal "${v}" isn't valid. Use breakfast, lunch or dinner.`);
  return m;
}
function parseDish(v) {
  const name = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!name) bad('dish is missing. Give the dish name, like "Dal tadka with jeera rice".');
  if (name.length > MAX_DISH_LEN) bad(`dish name is ${name.length} characters. Keep it to ${MAX_DISH_LEN} or fewer.`);
  return name;
}
function parseNumber(k, v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  const unit = k === 'calories' ? ' kcal' : 'g';
  if (!Number.isFinite(n) || n < 0 || n > LIMITS[k]) bad(`${k} must be a number from 0 to ${LIMITS[k]}${unit} (got ${JSON.stringify(v)}).`);
  return Math.round(n * 10) / 10;
}
// Reads calories/protein/... from src on top of base. Returns null if nothing is set.
function parseNutrition(src, base) {
  const out = {};
  let any = false;
  for (const k of NUTRIENTS) {
    const v = src[k];
    out[k] = v === undefined || v === null ? (base && base[k] != null ? base[k] : null) : parseNumber(k, v);
    if (out[k] != null) any = true;
  }
  if (!any) return null;
  if (out.calories == null) bad('Include calories too when you give nutrition (or leave all nutrition out).');
  return out;
}
const where = (i, item) => `Item ${i + 1}${item && item.date ? ` (${item.date}${item.meal ? ' ' + item.meal : ''})` : ''}`;
// Runs fn for one batch item; any input error is reported as "Item N (...): ... Nothing was saved."
function forItem(label, fn) {
  try { return fn(); } catch (e) {
    if (!(e instanceof InputError)) throw e;
    const msg = e.message.startsWith(label) ? e.message.slice(label.length).replace(/^:\s*/, '') : e.message;
    bad(`${label}: ${msg} Nothing was saved.`);
  }
}

// ---------- text ----------
const fmt = (n) => (Math.round(n * 10) / 10).toString();
function nutritionText(n) {
  if (!n) return 'nutrition missing';
  const parts = [`${fmt(n.calories)} kcal`];
  for (const k of ['protein', 'carbs', 'fat', 'fibre']) if (n[k] != null) parts.push(`${fmt(n[k])}g ${k}`);
  return parts.join(', ');
}
function slotLine(date, meal, slot) {
  if (!slot) return `${date} (${weekday(date)}) ${meal}: (empty)`;
  return `${date} (${weekday(date)}) ${meal}: ${slot.name} — ${nutritionText(slot.nutrition)}${slot.eaten ? ' — eaten' : ''}`;
}
const slotJson = (date, meal, slot) => ({
  date, meal,
  dish: slot ? slot.name : null,
  nutrition: slot ? (slot.nutrition || 'missing') : null,
  eaten: !!(slot && slot.eaten),
});
function result(summary, lines, structured, isError) {
  const body = lines && lines.length ? `${summary}\n\n${lines.join('\n')}` : summary;
  return { content: [{ type: 'text', text: body }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError: true } : {}) };
}

// ---------- context ----------
const mealsShownOf = (ws) => ({ breakfast: true, lunch: true, dinner: true, ...((ws.settings && ws.settings.meals) || {}) });
const slotOf = (ws, date, meal) => (ws.plan[date] && ws.plan[date][meal]) || null;

// Decides what to do with one dish to save. Returns { change } or { skip: reason }.
function prepareSet(ws, shown, item, overwriteEaten) {
  if (!shown[item.meal]) return { skip: `${item.meal} on ${longDay(item.date)}: ${item.meal} is switched off in Settings, so it wasn't planned` };
  const existing = slotOf(ws, item.date, item.meal);
  if (existing && existing.eaten && !overwriteEaten) {
    return { skip: `${item.meal} on ${longDay(item.date)}: already eaten (${existing.name}), so it was kept. Pass overwrite_eaten: true to replace it` };
  }
  return { change: { date: item.date, meal: item.meal, slot: { name: item.dish, nutrition: item.nutrition, eaten: false } } };
}
const SET_FIELDS = ['date', 'meal', 'dish', ...NUTRIENTS];
function parseSetItem(src, label) {
  checkFields(src, [...SET_FIELDS, 'overwrite_eaten'], label);
  return {
    date: parseDate(src.date),
    meal: parseMeal(src.meal),
    dish: parseDish(src.dish),
    nutrition: parseNutrition(src, null),
    overwriteEaten: src.overwrite_eaten === true,
  };
}
function savedSummary(changes) {
  const meals = [...new Set(changes.map((c) => c.meal))];
  if (meals.length === 1) {
    const m = meals[0];
    const what = changes.length === 1 ? m : MEAL_PLURAL[m];
    return `Saved ${changes.length} ${what}: ${changes.map((c) => `${shortDay(c.date)} ${c.slot.name}`).join(', ')}.`;
  }
  return `Saved ${changes.length} meals: ${changes.map((c) => `${shortDay(c.date)} ${c.meal} ${c.slot.name}`).join(', ')}.`;
}

// ---------- tool definitions ----------
const nutritionProps = {
  calories: { type: 'number', minimum: 0, maximum: LIMITS.calories, description: 'Estimated kcal for one serving.' },
  protein: { type: 'number', minimum: 0, maximum: 500, description: 'Estimated grams of protein.' },
  carbs: { type: 'number', minimum: 0, maximum: 500, description: 'Estimated grams of carbohydrate.' },
  fat: { type: 'number', minimum: 0, maximum: 500, description: 'Estimated grams of fat.' },
  fibre: { type: 'number', minimum: 0, maximum: 500, description: 'Estimated grams of fibre.' },
};
const dateProp = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Calendar date, YYYY-MM-DD.' };
const mealProp = { type: 'string', enum: MEALS };
const overwriteProp = { type: 'boolean', description: 'Only set true if the user explicitly wants to replace a meal they already marked as eaten.' };

const TOOLS = [
  {
    name: 'get_plan',
    title: 'Get meal plan',
    description:
      'Read the meal plan for a date range (at most 31 days). For each date you get breakfast, lunch and dinner with the dish, ' +
      'nutrition estimates (or "missing"), whether it was eaten, and a daily total. Meals the user switched off in Settings are left out. ' +
      "The reply starts with today's date, so you can work out \"tomorrow\", \"this weekend\" or \"next week\". " +
      'Call this before changing the plan so you can see what is already there.',
    inputSchema: {
      type: 'object',
      properties: { from: { ...dateProp, description: 'First date, YYYY-MM-DD.' }, to: { ...dateProp, description: 'Last date (inclusive), YYYY-MM-DD.' } },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'set_meal',
    title: 'Set one meal',
    description:
      'Create or replace one meal in the plan. Always include nutrition estimates (calories, protein, carbs, fat, fibre) when you add a dish. ' +
      'Never add a dish that conflicts with the allergies or diet from get_profile. ' +
      'Meals switched off in Settings are skipped, and a meal the user already marked as eaten is kept unless you pass overwrite_eaten: true. ' +
      'To plan several meals (for example a whole week) use set_meals instead.',
    inputSchema: {
      type: 'object',
      properties: {
        date: dateProp, meal: mealProp,
        dish: { type: 'string', minLength: 1, maxLength: MAX_DISH_LEN, description: 'Dish name, like "Rajma chawal".' },
        ...nutritionProps,
        overwrite_eaten: overwriteProp,
      },
      required: ['date', 'meal', 'dish'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'set_meals',
    title: 'Set several meals',
    description:
      'Create or replace up to 21 meals in one call, saved together. Use this for "plan my week" so the whole week is saved in one call. ' +
      'Always include nutrition estimates for every dish, and never add a dish that conflicts with the allergies or diet from get_profile. ' +
      'If any item is invalid, nothing is saved and the error says which item to fix. ' +
      'Meals switched off in Settings and meals already marked as eaten are skipped (the reply lists them).',
    inputSchema: {
      type: 'object',
      properties: {
        slots: {
          type: 'array', minItems: 1, maxItems: MAX_BATCH,
          items: {
            type: 'object',
            properties: { date: dateProp, meal: mealProp, dish: { type: 'string', minLength: 1, maxLength: MAX_DISH_LEN }, ...nutritionProps },
            required: ['date', 'meal', 'dish'],
            additionalProperties: false,
          },
        },
        overwrite_eaten: overwriteProp,
      },
      required: ['slots'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'fill_nutrition',
    title: 'Fill in nutrition',
    description:
      'Add or correct nutrition estimates on dishes that are already in the plan, without changing the dish names. ' +
      'Use this when the user asks you to fill in missing nutrition: call get_plan first to find dishes marked "missing", ' +
      'then send calories (required if the dish has none yet) plus protein, carbs, fat and fibre for each.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array', minItems: 1, maxItems: MAX_FILL,
          items: {
            type: 'object',
            properties: { date: dateProp, meal: mealProp, ...nutritionProps },
            required: ['date', 'meal'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'clear_meal',
    title: 'Clear a meal',
    description: 'Empty one meal slot. A meal already marked as eaten is kept unless you pass overwrite_eaten: true.',
    inputSchema: {
      type: 'object',
      properties: { date: dateProp, meal: mealProp, overwrite_eaten: overwriteProp },
      required: ['date', 'meal'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'set_eaten',
    title: 'Mark a meal as eaten',
    description: 'Mark a planned meal as eaten (true) or not eaten (false), for example when the user says "I had the poha".',
    inputSchema: {
      type: 'object',
      properties: { date: dateProp, meal: mealProp, eaten: { type: 'boolean' } },
      required: ['date', 'meal', 'eaten'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];
const NAMES = new Set(TOOLS.map((t) => t.name));

// ---------- handlers ----------
const handlers = {
  async get_plan(args, { ws }) {
    checkFields(args, ['from', 'to'], 'get_plan');
    const from = parseDate(args.from, 'from');
    const to = parseDate(args.to, 'to');
    if (from > to) bad(`from (${from}) is after to (${to}). Swap them.`);
    const days = Math.round((utc(to) - utc(from)) / 86400000) + 1;
    if (days > MAX_DAYS) bad(`That's ${days} days. Ask for ${MAX_DAYS} days or fewer at a time.`);
    const shown = mealsShownOf(ws);
    const visible = MEALS.filter((m) => shown[m]);
    const hidden = MEALS.filter((m) => !shown[m]);
    const today = todayYmd();
    const lines = [];
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const meals = {};
      const total = { calories: 0, protein: 0, carbs: 0, fat: 0, fibre: 0 };
      let counted = 0;
      let missing = 0;
      lines.push(`${d} ${weekday(d)}${d === today ? ' (today)' : ''}`);
      for (const m of visible) {
        const slot = slotOf(ws, d, m);
        meals[m] = slotJson(d, m, slot);
        lines.push(`  ${m}: ${slot ? `${slot.name} — ${nutritionText(slot.nutrition)}${slot.eaten ? ' — eaten' : ''}` : '(empty)'}`);
        if (slot && slot.nutrition) { counted++; for (const k of NUTRIENTS) total[k] += Number(slot.nutrition[k]) || 0; } else if (slot) missing++;
      }
      const totalText = counted ? `${nutritionText(total)} (estimate)` : 'no nutrition yet';
      lines.push(`  Day total: ${totalText}${missing ? ` — ${missing} dish${missing === 1 ? '' : 'es'} missing nutrition` : ''}`);
      out.push({ date: d, weekday: weekday(d), meals, total: counted ? total : null, missingNutrition: missing });
    }
    const head = `Today is ${today} (${weekday(today)}). Plan from ${from} to ${to}. ` +
      `Meals shown: ${visible.join(', ')}${hidden.length ? `; switched off (leave alone): ${hidden.join(', ')}` : ''}.`;
    return result(head, lines, { today, from, to, mealsShown: visible, days: out });
  },

  async set_meal(args, { ws, store, key }) {
    const item = parseSetItem(args, 'set_meal');
    const p = prepareSet(ws, mealsShownOf(ws), item, item.overwriteEaten);
    if (p.skip) return result(`Nothing saved. Skipped ${p.skip}.`, [slotLine(item.date, item.meal, slotOf(ws, item.date, item.meal))]);
    await store.setMeals(key, [p.change]);
    return result(savedSummary([p.change]), [slotLine(p.change.date, p.change.meal, p.change.slot)]);
  },

  async set_meals(args, { ws, store, key }) {
    checkFields(args, ['slots', 'overwrite_eaten'], 'set_meals');
    if (!Array.isArray(args.slots) || !args.slots.length) bad('slots must be a list of {date, meal, dish, calories, protein, carbs, fat, fibre}.');
    if (args.slots.length > MAX_BATCH) bad(`That's ${args.slots.length} slots. Send at most ${MAX_BATCH} per call (split the rest into another call).`);
    const items = args.slots.map((s, i) => forItem(where(i, s), () => parseSetItem(s, where(i, s))));
    const seen = new Set();
    items.forEach((it, i) => {
      const k = `${it.date} ${it.meal}`;
      if (seen.has(k)) bad(`${where(i, it)}: ${it.meal} on ${it.date} appears twice. Send each slot once. Nothing was saved.`);
      seen.add(k);
    });
    const shown = mealsShownOf(ws);
    const overwrite = args.overwrite_eaten === true;
    const changes = [];
    const skipped = [];
    for (const it of items) {
      const p = prepareSet(ws, shown, it, overwrite || it.overwriteEaten);
      if (p.skip) skipped.push(p.skip); else changes.push(p.change);
    }
    if (changes.length) await store.setMeals(key, changes);
    const summary = [changes.length ? savedSummary(changes) : 'Nothing saved.'];
    if (skipped.length) summary.push(`Skipped ${skipped.length}: ${skipped.join('; ')}.`);
    return result(summary.join(' '), changes.map((c) => slotLine(c.date, c.meal, c.slot)));
  },

  async fill_nutrition(args, { ws, store, key }) {
    checkFields(args, ['items'], 'fill_nutrition');
    if (!Array.isArray(args.items) || !args.items.length) bad('items must be a list of {date, meal, calories, protein, carbs, fat, fibre}.');
    if (args.items.length > MAX_FILL) bad(`That's ${args.items.length} items. Send at most ${MAX_FILL} per call.`);
    const changes = [];
    const skipped = [];
    const seen = new Set();
    args.items.forEach((src, i) => {
      const label = where(i, src);
      forItem(label, () => {
        checkFields(src, ['date', 'meal', ...NUTRIENTS], label);
        const date = parseDate(src.date);
        const meal = parseMeal(src.meal);
        if (seen.has(`${date} ${meal}`)) bad(`${meal} on ${date} appears twice. Send each dish once.`);
        seen.add(`${date} ${meal}`);
        if (!NUTRIENTS.some((k) => src[k] !== undefined && src[k] !== null)) bad('no nutrition given. Send at least calories.');
        const slot = slotOf(ws, date, meal);
        if (!slot) { skipped.push(`${meal} on ${longDay(date)}: no dish there`); return; }
        const nutrition = parseNutrition(src, slot.nutrition);
        changes.push({ date, meal, slot: { ...slot, nutrition } });
      });
    });
    if (changes.length) await store.setMeals(key, changes);
    const summary = [changes.length
      ? `Filled nutrition for ${changes.length} dish${changes.length === 1 ? '' : 'es'}: ${changes.map((c) => `${shortDay(c.date)} ${c.meal} ${c.slot.name} (${fmt(c.slot.nutrition.calories)} kcal)`).join(', ')}.`
      : 'Nothing saved.'];
    if (skipped.length) summary.push(`Skipped ${skipped.length}: ${skipped.join('; ')}.`);
    return result(summary.join(' '), changes.map((c) => slotLine(c.date, c.meal, c.slot)));
  },

  async clear_meal(args, { ws, store, key }) {
    checkFields(args, ['date', 'meal', 'overwrite_eaten'], 'clear_meal');
    const date = parseDate(args.date);
    const meal = parseMeal(args.meal);
    const slot = slotOf(ws, date, meal);
    if (!slot) return result(`${meal} on ${longDay(date)} was already empty. Nothing changed.`, [slotLine(date, meal, null)]);
    if (slot.eaten && args.overwrite_eaten !== true) {
      return result(`Kept ${meal} on ${longDay(date)} (${slot.name}) because it's marked as eaten. Pass overwrite_eaten: true to clear it anyway.`, [slotLine(date, meal, slot)]);
    }
    await store.setMeals(key, [{ date, meal, slot: null }]);
    return result(`Cleared ${meal} on ${longDay(date)} (was ${slot.name}).`, [slotLine(date, meal, null)]);
  },

  async set_eaten(args, { ws, store, key }) {
    checkFields(args, ['date', 'meal', 'eaten'], 'set_eaten');
    const date = parseDate(args.date);
    const meal = parseMeal(args.meal);
    if (typeof args.eaten !== 'boolean') bad('eaten must be true or false.');
    const slot = slotOf(ws, date, meal);
    if (!slot) bad(`There's no dish for ${meal} on ${date}. Add one with set_meal first.`);
    const next = { ...slot, eaten: args.eaten };
    await store.setMeals(key, [{ date, meal, slot: next }]);
    return result(`Marked ${meal} on ${longDay(date)} (${slot.name}) as ${args.eaten ? 'eaten' : 'not eaten'}.`, [slotLine(date, meal, next)]);
  },
};

async function callPlanTool(name, args, ctx) {
  try {
    return await handlers[name](args && typeof args === 'object' ? args : {}, ctx);
  } catch (e) {
    if (e instanceof InputError) return result(e.message, null, null, true);
    throw e;
  }
}

// ---------- the "plan my week" prompt ----------
const PROMPTS = [
  {
    name: 'plan_week',
    title: 'Plan my week',
    description: 'Plan 7 days of meals around your profile, kitchen and existing plan.',
    arguments: [
      { name: 'start_date', description: 'First day, YYYY-MM-DD (default: tomorrow)', required: false },
      { name: 'notes', description: 'Anything special this week, e.g. "light dinners" or "guests on Saturday"', required: false },
    ],
  },
];
function planWeekText(args) {
  const start = args && isDate(args.start_date) ? args.start_date : 'tomorrow';
  const notes = args && typeof args.notes === 'string' && args.notes.trim() ? `\nNotes for this week: ${args.notes.trim().slice(0, 500)}\n` : '';
  return `Please plan my meals for the 7 days starting ${start}.${notes}
How to do it:
1. Call get_profile (diet, allergies, cuisines, taste, dislikes and which meals are shown) and get_kitchen (what I have at home). Allergies and diet are strict rules.
2. Call get_plan for those 7 days to see what's already there. Keep dishes I've already planned or eaten unless I ask you to change them; fill the empty slots.
3. Plan only the meals that are switched on. Vary dishes across the days (don't repeat a dish in the same week unless I ask), use what's in my kitchen where it makes sense, and match my cuisines and spice level.
4. Save everything in one set_meals call, with nutrition estimates (calories, protein, carbs, fat, fibre) for every dish.
5. Finish with a one-line summary for me.`;
}

module.exports = { PLAN_TOOLS: TOOLS, isPlanTool: (n) => NAMES.has(n), callPlanTool, PROMPTS, planWeekText };
