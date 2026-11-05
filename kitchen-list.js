// The kitchen list: ingredients the user has at home, newest first.
// Item = { id, name, addedAt }. Shared by the web API and the MCP tools.
const crypto = require('crypto');

const MAX_ITEMS = 300;
const MAX_NAME_LEN = 60;

const cleanName = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const listOf = (ws) => (Array.isArray(ws.kitchen) ? ws.kitchen : []);
const newId = () => crypto.randomBytes(9).toString('base64url');

/**
 * Adds names to a copy of the list. Duplicates (ignoring case) are skipped.
 * addedAt (optional ISO time) puts a restored item back in its old place.
 * Returns { list, added, skipped, invalid } (added/skipped/invalid are names).
 */
function addNames(list, names, addedAt) {
  const out = list.slice();
  const added = [], skipped = [], invalid = [];
  for (const raw of names) {
    const name = cleanName(raw);
    if (!name) continue;
    if (name.length > MAX_NAME_LEN) { invalid.push(name); continue; }
    if (out.some((i) => same(i.name, name))) { skipped.push(name); continue; }
    if (out.length >= MAX_ITEMS) { invalid.push(name); continue; }
    const item = { id: newId(), name, addedAt: addedAt || new Date().toISOString() };
    const at = addedAt ? out.findIndex((i) => i.addedAt < addedAt) : 0; // newest first
    if (at === -1) out.push(item); else out.splice(at, 0, item);
    added.push(name);
  }
  return { list: out, added, skipped, invalid };
}

// Removes names (ignoring case). Returns { list, removed, notFound }.
function removeNames(list, names) {
  let out = list.slice();
  const removed = [], notFound = [];
  for (const raw of names) {
    const name = cleanName(raw);
    if (!name) continue;
    const hit = out.find((i) => same(i.name, name));
    if (hit) { out = out.filter((i) => i !== hit); removed.push(hit.name); } else notFound.push(name);
  }
  return { list: out, removed, notFound };
}

function describeKitchen(list) {
  if (!list.length) return 'The kitchen list is empty.';
  return `Kitchen (${list.length} ingredient${list.length === 1 ? '' : 's'}, newest first): ${list.map((i) => i.name).join(', ')}`;
}

module.exports = { MAX_ITEMS, MAX_NAME_LEN, cleanName, listOf, addNames, removeNames, describeKitchen };
