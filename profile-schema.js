// The food profile: allowed values, validation and a plain-text description.
// Shared by the web API (PUT /api/:key/profile) and the MCP tools.

const DIETS = ['vegetarian', 'eggetarian', 'non-vegetarian', 'vegan'];
const CUISINES = ['North Indian', 'South Indian', 'Punjabi', 'Gujarati', 'Maharashtrian', 'Bengali', 'Other'];
const TASTES = ['mild', 'normal', 'spicy'];
const ALLERGIES = ['peanuts', 'dairy', 'gluten', 'eggs', 'soy', 'other'];
const FIELDS = ['diet', 'cuisines', 'taste', 'dislikes', 'allergies', 'allergyNote'];
const MAX_DISLIKES = 50;
const MAX_DISLIKE_LEN = 40;
const MAX_NOTE_LEN = 300;

const emptyProfile = () => ({ diet: null, cuisines: [], taste: null, dislikes: [], allergies: [], allergyNote: '' });

// Case/spacing-insensitive match against a list of allowed values ("Non vegetarian" -> "non-vegetarian").
const norm = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, ' ').trim();
const pick = (list, value) => list.find((v) => norm(v) === norm(value)) || null;

function pickList(value, allowed, field, errors) {
  if (!Array.isArray(value)) { errors.push(`${field} must be a list`); return null; }
  const chosen = new Set();
  for (const item of value) {
    const v = typeof item === 'string' ? pick(allowed, item) : null;
    if (!v) { errors.push(`${field} can only contain: ${allowed.join(', ')}`); return null; }
    chosen.add(v);
  }
  return allowed.filter((v) => chosen.has(v)); // canonical order, no duplicates
}

/**
 * Applies the known fields present in `src` on top of `base`.
 * Returns { profile } or { error }. Fields not in `src` keep their value from `base`.
 */
function applyProfileFields(src, base) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return { error: 'Profile must be an object' };
  const p = JSON.parse(JSON.stringify({ ...emptyProfile(), ...(base || {}) }));
  const errors = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);

  if (has('diet')) {
    if (src.diet == null || src.diet === '') p.diet = null;
    else if (!(p.diet = pick(DIETS, src.diet))) errors.push(`diet must be one of: ${DIETS.join(', ')} (or null)`);
  }
  if (has('taste')) {
    if (src.taste == null || src.taste === '') p.taste = null;
    else if (!(p.taste = pick(TASTES, src.taste))) errors.push(`taste must be one of: ${TASTES.join(', ')} (or null)`);
  }
  if (has('cuisines')) { const v = pickList(src.cuisines, CUISINES, 'cuisines', errors); if (v) p.cuisines = v; }
  if (has('allergies')) { const v = pickList(src.allergies, ALLERGIES, 'allergies', errors); if (v) p.allergies = v; }
  if (has('dislikes')) {
    if (!Array.isArray(src.dislikes)) errors.push('dislikes must be a list of ingredient names');
    else {
      const out = [];
      for (const item of src.dislikes) {
        if (typeof item !== 'string') { errors.push('dislikes must be a list of ingredient names'); break; }
        const name = item.trim().replace(/\s+/g, ' ');
        if (!name) continue;
        if (name.length > MAX_DISLIKE_LEN) { errors.push(`each disliked ingredient must be ${MAX_DISLIKE_LEN} characters or fewer`); break; }
        if (!out.some((d) => d.toLowerCase() === name.toLowerCase())) out.push(name);
      }
      if (out.length > MAX_DISLIKES) errors.push(`at most ${MAX_DISLIKES} disliked ingredients`);
      p.dislikes = out;
    }
  }
  if (has('allergyNote')) {
    if (src.allergyNote == null) p.allergyNote = '';
    else if (typeof src.allergyNote !== 'string') errors.push('allergyNote must be text');
    else if (src.allergyNote.trim().length > MAX_NOTE_LEN) errors.push(`allergyNote must be ${MAX_NOTE_LEN} characters or fewer`);
    else p.allergyNote = src.allergyNote.trim();
  }
  return errors.length ? { error: errors.join('; ') } : { profile: p };
}

const DIET_TEXT = {
  vegetarian: 'Vegetarian (no meat, fish or eggs; dairy is fine)',
  eggetarian: 'Eggetarian (vegetarian plus eggs; no meat or fish)',
  'non-vegetarian': 'Non-vegetarian (eats meat, fish and eggs)',
  vegan: 'Vegan (no meat, fish, eggs, dairy or honey)',
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Plain, readable profile for Claude.
// mealsShown (optional): { breakfast, lunch, dinner } booleans from the app's settings.
function describeProfile(profile, saved, mealsShown) {
  const p = { ...emptyProfile(), ...(profile || {}) };
  const lines = ['Food profile'];
  if (mealsShown) {
    const meals = ['breakfast', 'lunch', 'dinner'];
    const on = meals.filter((m) => mealsShown[m] !== false).map(cap);
    const off = meals.filter((m) => mealsShown[m] === false).map(cap);
    lines.push(`- Meals shown in the app (ONLY plan these): ${on.join(', ')}${off.length ? `. Switched off, do not plan: ${off.join(', ')}` : ''}`);
  }
  if (!saved) lines.push('(The user has not filled in their profile yet. Ask them about diet and allergies before planning.)');
  lines.push(`- Diet: ${p.diet ? DIET_TEXT[p.diet] : 'not set'}`);
  lines.push(`- Favourite cuisines: ${p.cuisines.length ? p.cuisines.join(', ') : 'none chosen'}`);
  lines.push(`- Taste / spice level: ${p.taste ? cap(p.taste) : 'not set'}`);
  lines.push(`- Ingredients they dislike (avoid where possible): ${p.dislikes.length ? p.dislikes.join(', ') : 'none'}`);
  lines.push(`- Allergies and restrictions (STRICT - never include these, or any dish or ingredient that contains them): ${
    p.allergies.length ? p.allergies.map(cap).join(', ') : 'none listed'}`);
  lines.push(`- Other allergy or restriction notes (STRICT): ${p.allergyNote ? p.allergyNote : 'none'}`);
  return lines.join('\n');
}

module.exports = {
  DIETS, CUISINES, TASTES, ALLERGIES, FIELDS, MAX_DISLIKE_LEN, MAX_NOTE_LEN,
  emptyProfile, applyProfileFields, describeProfile,
};
