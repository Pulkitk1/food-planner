// MCP server (Streamable HTTP, JSON responses) at POST /mcp/:token.
// No AI here: these tools only read and write the user's saved data. The user's
// own Claude calls them and does all the thinking.
const {
  DIETS, CUISINES, TASTES, ALLERGIES, FIELDS, MAX_DISLIKE_LEN, MAX_NOTE_LEN,
  emptyProfile, applyProfileFields, describeProfile,
} = require('./profile-schema');
const kitchen = require('./kitchen-list');
const { PLAN_TOOLS, isPlanTool, callPlanTool, PROMPTS, planWeekText } = require('./mcp-plan');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const SERVER_INSTRUCTIONS =
  'Food Planner stores one person\'s meal plan (by date: breakfast, lunch, dinner), food profile and kitchen list. ' +
  'Before planning or suggesting meals, call get_profile (diet, cuisines, taste, dislikes, allergies, meals shown) and get_kitchen (what is at home). ' +
  'Allergies and diet are strict rules: never include them. ' +
  'To plan a week: read the profile, kitchen and the existing plan (get_plan) first; vary dishes across days; fill only the meals that are switched on; ' +
  'include nutrition estimates (calories, protein, carbs, fat, fibre) for every dish; save the week in one set_meals call; ' +
  'then finish with a one-line summary for the user. ' +
  'When the user mentions ingredients they have, add them with add_to_kitchen.';

const TOOLS = [
  {
    name: 'get_profile',
    title: 'Get food profile',
    description:
      "Get the user's food profile: which meals they want planned (breakfast, lunch, dinner), diet, favourite cuisines, spice level, " +
      'disliked ingredients, and allergies and restrictions. ' +
      'ALWAYS call this before you suggest, plan or change any meals, and follow it. ' +
      'Before planning meals, also call get_kitchen to see what is at home. ' +
      'Only plan the meals listed as shown; never plan a meal that is switched off. ' +
      'Allergies and restrictions are strict rules: never include a listed allergen, or any dish, sauce, oil, garnish or ingredient that contains it. ' +
      'If you are not sure whether a dish contains an allergen, choose a different dish. ' +
      'Keep to the diet (for example no eggs for vegetarian, no dairy for vegan), avoid disliked ingredients where possible, ' +
      'and prefer the favourite cuisines and the chosen spice level.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'update_profile',
    title: 'Update food profile',
    description:
      "Update the user's food profile. Only the fields you pass are changed; everything else stays as it is. " +
      'Only call this when the user asks you to change their preferences or tells you something new about themselves ' +
      "(for example \"I've stopped eating eggs\" or \"I'm allergic to peanuts\"). Do not guess preferences. " +
      'List fields (cuisines, dislikes, allergies) replace the whole list, so call get_profile first and send the full updated list. ' +
      'Never remove an allergy unless the user clearly says it no longer applies.',
    inputSchema: {
      type: 'object',
      properties: {
        diet: { type: ['string', 'null'], enum: [...DIETS, null], description: 'One diet, or null to clear it.' },
        cuisines: { type: 'array', items: { type: 'string', enum: CUISINES }, description: 'Favourite cuisines (replaces the list).' },
        taste: { type: ['string', 'null'], enum: [...TASTES, null], description: 'Spice level, or null to clear it.' },
        dislikes: {
          type: 'array', items: { type: 'string', maxLength: MAX_DISLIKE_LEN },
          description: 'Ingredient names the user dislikes (replaces the list).',
        },
        allergies: { type: 'array', items: { type: 'string', enum: ALLERGIES }, description: 'Allergies and restrictions (replaces the list).' },
        allergyNote: { type: 'string', maxLength: MAX_NOTE_LEN, description: 'Free-text note about other allergies or restrictions.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_kitchen',
    title: 'Get kitchen list',
    description:
      "Get the list of ingredients the user has at home (their 'kitchen'), newest first. " +
      'Before planning meals, call get_profile (diet, cuisines, taste, dislikes, allergies, meals shown) and this tool, ' +
      'and prefer dishes that use what they already have. Also call it when the user asks what they can cook. ' +
      'Allergies and diet from get_profile are strict rules: never suggest anything that breaks them, even if the ingredient is in the kitchen.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'add_to_kitchen',
    title: 'Add to kitchen list',
    description:
      'Add ingredients to the user\'s kitchen list. Whenever the user tells you what ingredients they have ' +
      "(for example \"I have paneer, spinach and rice\" or \"I just bought eggs\"), call this with each ingredient as a separate name. " +
      'Use short, plain names like "paneer" or "basmati rice", without amounts. Ingredients already on the list (ignoring case) are skipped. ' +
      'Returns the updated list.',
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'array', minItems: 1, maxItems: 50,
          items: { type: 'string', minLength: 1, maxLength: kitchen.MAX_NAME_LEN },
          description: 'Ingredient names, one per item.',
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'remove_from_kitchen',
    title: 'Remove from kitchen list',
    description:
      "Remove ingredients from the user's kitchen list (matching names, ignoring case). " +
      'Call this when the user says they have run out of something or used it up. Returns the updated list.',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1 }, description: 'Ingredient names to remove.' },
      },
      required: ['names'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

const text = (t, isError) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

const ALL_TOOLS = () => TOOLS.concat(PLAN_TOOLS);

async function callTool(store, key, name, args) {
  const ws = await store.getWorkspace(key);
  if (isPlanTool(name)) return callPlanTool(name, args, { ws, store, key });
  const current = { ...emptyProfile(), ...(ws.profile || {}) };

  const mealsShown = { breakfast: true, lunch: true, dinner: true, ...((ws.settings && ws.settings.meals) || {}) };
  if (name === 'get_profile') return text(describeProfile(current, ws.profileSaved, mealsShown));

  if (name === 'update_profile') {
    const src = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const unknown = Object.keys(src).filter((k) => !FIELDS.includes(k));
    if (unknown.length) return text(`Unknown field(s): ${unknown.join(', ')}. Allowed: ${FIELDS.join(', ')}.`, true);
    if (!Object.keys(src).length) return text(`Pass at least one of: ${FIELDS.join(', ')}.`, true);
    const result = applyProfileFields(src, current);
    if (result.error) return text(`Profile not changed: ${result.error}`, true);
    await store.updateMeta(key, { profile: result.profile, profileSaved: true });
    return text(`Profile updated (${Object.keys(src).join(', ')}).\n\n${describeProfile(result.profile, true, mealsShown)}`);
  }

  if (name === 'get_kitchen') return text(kitchen.describeKitchen(kitchen.listOf(ws)));

  if (name === 'add_to_kitchen' || name === 'remove_from_kitchen') {
    const names = args && Array.isArray(args.names) ? args.names.filter((n) => typeof n === 'string') : null;
    if (!names || !names.length) return text('Pass "names": a list of ingredient names.', true);
    if (names.length > 50) return text('Pass at most 50 names at a time.', true);
    const notes = [];
    let list;
    if (name === 'add_to_kitchen') {
      const r = kitchen.addNames(kitchen.listOf(ws), names);
      list = r.list;
      if (r.added.length) notes.push(`Added: ${r.added.join(', ')}.`);
      if (r.skipped.length) notes.push(`Already there (skipped): ${r.skipped.join(', ')}.`);
      if (r.invalid.length) notes.push(`Not added (too long or list full): ${r.invalid.join(', ')}.`);
      if (r.added.length) await store.updateMeta(key, { kitchen: list });
    } else {
      const r = kitchen.removeNames(kitchen.listOf(ws), names);
      list = r.list;
      if (r.removed.length) notes.push(`Removed: ${r.removed.join(', ')}.`);
      if (r.notFound.length) notes.push(`Not on the list: ${r.notFound.join(', ')}.`);
      if (r.removed.length) await store.updateMeta(key, { kitchen: list });
    }
    return text(`${notes.join(' ') || 'Nothing changed.'}\n\n${kitchen.describeKitchen(list)}`);
  }
  return null;
}

async function handle(store, key, msg) {
  const isRequest = msg && Object.prototype.hasOwnProperty.call(msg, 'id');
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: isRequest ? msg.id : null, error: { code, message } });

  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
  if (!isRequest) return null; // notifications (e.g. notifications/initialized) need no reply

  const params = msg.params || {};
  switch (msg.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'food-planner', title: 'Food Planner', version: '0.1.0' },
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: ALL_TOOLS() });
    case 'prompts/list':
      return reply({ prompts: PROMPTS });
    case 'prompts/get': {
      if (params.name !== 'plan_week') return fail(-32602, `Unknown prompt: ${params.name}`);
      return reply({
        description: PROMPTS[0].description,
        messages: [{ role: 'user', content: { type: 'text', text: planWeekText(params.arguments || {}) } }],
      });
    }
    case 'tools/call': {
      const out = await callTool(store, key, params.name, params.arguments);
      return out ? reply(out) : fail(-32602, `Unknown tool: ${params.name}`);
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

function mountMcp(app, store) {
  app.post('/mcp/:token', async (req, res, next) => {
    try {
      // Browsers send Origin; Claude's servers don't. Block other websites' pages.
      const origin = req.get('origin');
      if (origin) {
        let same = false;
        try { same = new URL(origin).host === req.get('host'); } catch { /* bad origin */ }
        if (!same) return res.status(403).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed' } });
      }
      const { token } = req.params;
      const key = TOKEN_RE.test(token) ? await store.keyForMcpToken(token) : null;
      if (!key) return res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unknown or reset link' } });
      await store.markMcp(key); // Home/Profile show "Claude connected" once any MCP request arrives

      const body = req.body;
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map((m) => handle(store, key, m)))).filter(Boolean);
        return out.length ? res.json(out) : res.status(202).end();
      }
      const out = await handle(store, key, body);
      return out ? res.json(out) : res.status(202).end();
    } catch (e) {
      next(e);
    }
  });
  // No server-sent event stream or sessions: only POST is supported.
  app.all('/mcp/:token', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST' }));
}

module.exports = { mountMcp, TOOLS };
