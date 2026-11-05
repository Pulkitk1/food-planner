# Food Planner (working name)

Meal planner for working professionals. **No AI inside the app**: no model API keys, no model calls. Users connect their own Claude via MCP; the app only saves, shows and edits data.

## Run locally

```
npm install
npm start            # http://localhost:3000  (set PORT=3100 to change)
```

Open the root URL and press **Get started**. You get a private workspace at `/w/:key`, already filled with a sample week.

Storage: if `DATABASE_URL` is set, the app uses Postgres and creates the `workspaces` table on startup. If not, it uses `data.json` in the project folder (override with `DATA_FILE`). Set `PGSSL=disable` for a non-SSL remote Postgres.

## API

The plan is keyed by calendar date: `{ "2026-11-05": { breakfast, lunch, dinner } }`. A slot is `{ name, nutrition }`, or `null` when empty. `nutrition` is `null` or `{ calories, protein, carbs, fat, fibre }` (all estimates; if present it must include calories).

- `GET /api/:key/plan?from=YYYY-MM-DD&to=YYYY-MM-DD` returns `{ plan, claudeConnected, mcpLastSeen }` for that range (both params optional, max 400 days)
- `PUT /api/:key/plan/:date/:meal` (meal `breakfast|lunch|dinner`) sets or updates a slot
  - body `{ "name": "Poha", "nutrition": { "calories": 250, "protein": 6, "carbs": 45, "fat": 6, "fibre": 3 } }`
  - fields you leave out keep their current value, so `{ "nutrition": null }` only clears nutrition. `name` is required for a new slot.
- `DELETE /api/:key/plan/:date/:meal` clears a slot

Workspaces created before dates were introduced (weekday plans) are migrated on startup into 21 dated days starting 2 days before today. `data.json.bak` keeps the original.
- `GET /api/:key/profile` returns `{ profile, profileSaved, onboarded, claudeConnected, mcpUrl }`
- `PUT /api/:key/profile` saves the whole profile: `{ diet, cuisines, taste, dislikes, allergies, allergyNote }`
  - diet: `vegetarian | eggetarian | non-vegetarian | vegan | null`; taste: `mild | normal | spicy | null`
  - cuisines: any of `North Indian, South Indian, Punjabi, Gujarati, Maharashtrian, Bengali, Other`
  - allergies: any of `peanuts, dairy, gluten, eggs, soy, other`; dislikes: free-text names (max 50, 40 chars each)
- `POST /api/:key/onboarding` marks the first-run flow done. Until the profile is saved once or the flow is finished/skipped, Home redirects to `/w/:key/welcome`.
- `GET /api/:key/kitchen` returns `{ items: [{ id, name, addedAt }] }`, newest first
- `POST /api/:key/kitchen` with `{ "name": "paneer" }` adds one item. Duplicates (ignoring case) aren't added and return `{ item: null, duplicate: true }`.
- `DELETE /api/:key/kitchen/:id` removes one item
- `GET /api/:key/settings` / `PUT /api/:key/settings` with `{ "meals": { "breakfast": true, "lunch": false, "dinner": true } }`. Hidden meals keep their data; at least one must stay on (400 otherwise). `GET /api/:key/plan` also returns `settings`.
- `GET /api/:key/subscription` returns `{ createdAt, trialDays, trialDay, trialDaysLeft, trialEnded, trialEndsOn, priceLaunch, priceLater }`. Display only: no payments yet and nothing is locked after the trial. Prices and trial length live in `plan-config.js`. A workspace without a creation date gets one (now) the first time this is read.
- `GET /api/:key/invite` returns `{ inviteUrl }` like `https://your-site/invite/k7Qp2x9A` (built from `BASE_URL`). The 8-character code is random and separate from the workspace key; it's created the first time it's needed.
- `GET /invite/:code` redirects to `/?ref=CODE` if the code exists, otherwise to `/`. The start page passes the code in a hidden field, and a new workspace saves it as `referredBy` (nothing else uses it yet). Deleting a workspace removes its code.
- `GET /api/:key/export` downloads `food-planner-export.json` (profile, kitchen, plan, settings; the secret Claude link is left out).
- `DELETE /api/:key` deletes the workspace for good (also from `data.json.bak` if present); its MCP link stops working.
- `POST /api/:key/mcp-link/reset` issues a new MCP link; the old one stops working at once.

## MCP (connect your own Claude)

Each workspace has a private link `/mcp/<token>` (shown on the Profile page). It's a Streamable HTTP MCP endpoint (POST, JSON responses, no sessions). Tools:

- `get_profile`: the food profile as readable text. Its description tells Claude to read it before planning and to treat allergies strictly.
- `update_profile`: changes only the fields passed.
- `get_kitchen`, `add_to_kitchen` (`names`: list; duplicates skipped) and `remove_from_kitchen` (`names`: list). Each returns the updated list.
- Plan tools:
  - `get_plan` (`from`, `to`; max 31 days; includes today's date and daily totals)
  - `set_meal` and `set_meals` (up to 21 slots, all-or-nothing on bad input)
  - `fill_nutrition`, `clear_meal`, `set_eaten`
  - Limits: calories 0–5000, grams 0–500, dish names up to 100 characters.
  - Meals switched off in Settings are skipped and left out of `get_plan`.
  - Meals marked eaten are kept unless `overwrite_eaten: true` is passed.
- Prompt `plan_week` (and the server `instructions`) describe how Claude should plan a week.

Try it from the command line: `node scripts/try-mcp.mjs <your MCP link>`. It's read-only; add `--demo` to save two sample dinners.

Any request to the link marks the workspace "Claude connected". Claude's custom connectors need a public **https** URL, so a `localhost` link only works once the app is hosted (or tunnelled). Set `BASE_URL` (e.g. `https://food.example.com`) so the link shown in the app uses it.
