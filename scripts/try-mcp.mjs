// Try the Food Planner MCP tools from the command line, the way Claude calls them.
//
//   node scripts/try-mcp.mjs <your MCP link>            read only: initialize, list tools, show this week's plan
//   node scripts/try-mcp.mjs <your MCP link> --demo     also saves two sample dinners (tomorrow and the day after)
//
// Your MCP link is on the Profile page under "Claude connection".
const [link, flag] = process.argv.slice(2);
if (!link || !/\/mcp\//.test(link)) {
  console.error('Usage: node scripts/try-mcp.mjs <your MCP link from the Profile page> [--demo]');
  process.exit(1);
}

let id = 0;
async function rpc(method, params) {
  const res = await fetch(link, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  if (res.status === 404) throw new Error('This link is not known (it may have been reset). Copy it again from the Profile page.');
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}
const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).content[0].text;
const pad = (x) => String(x).padStart(2, '0');
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'try-mcp', version: '1' } });
  console.log(`Connected to ${init.serverInfo.title} (protocol ${init.protocolVersion})\n`);
  const { tools } = await rpc('tools/list');
  console.log(`Tools: ${tools.map((t) => t.name).join(', ')}\n`);

  if (flag === '--demo') {
    console.log('== set_meals ==');
    console.log(await call('set_meals', { slots: [
      { date: day(1), meal: 'dinner', dish: 'Dal tadka with jeera rice', calories: 520, protein: 18, carbs: 80, fat: 12, fibre: 9 },
      { date: day(2), meal: 'dinner', dish: 'Palak paneer with roti', calories: 560, protein: 24, carbs: 48, fat: 28, fibre: 7 },
    ] }));
    console.log();
  }

  console.log('== get_plan (next 7 days) ==');
  console.log(await call('get_plan', { from: day(0), to: day(6) }));
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
