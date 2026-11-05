// Shared page layout: a fixed left sidebar plus the page content.
// Every workspace page is rendered through renderPage(), so new screens only
// supply their content.

const TABS = [
  {
    id: 'home', label: 'Home', path: '',
    icon: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  },
  {
    id: 'planner', label: 'Planner', path: '/planner',
    icon: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  },
  {
    id: 'kitchen', label: 'My Kitchen', path: '/kitchen',
    icon: '<path d="M4 10h16v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-7Z"/><path d="M2 10h20M9 6.5c0-1 .8-1.5.8-2.5M14 6.5c0-1 .8-1.5.8-2.5"/>',
  },
  {
    id: 'profile', label: 'Profile', path: '/profile',
    icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.2-4 4.2-6 8-6s6.8 2 8 6"/>',
  },
];

// Runs in <head> before first paint. Preference is 'light' | 'dark' (default for
// anyone who hasn't chosen) | 'system'. Sets data-theme and color-scheme on <html>,
// follows the device setting live while on 'system', and exposes window.fpTheme
// for the Settings page. If localStorage is blocked, the choice still applies for
// the current page.
const THEME_SCRIPT = `(function(){var d=document.documentElement,K='fp-theme',mem=null,` +
  `m=window.matchMedia?matchMedia('(prefers-color-scheme: dark)'):null;` +
  `function ok(v){return v==='light'||v==='dark'||v==='system'}` +
  `function get(){var v=null;try{v=localStorage.getItem(K)}catch(e){}if(!ok(v))v=mem;return ok(v)?v:'dark'}` +
  `function apply(){var p=get(),t=p==='system'?(m&&m.matches?'dark':'light'):p;d.setAttribute('data-theme',t);d.style.colorScheme=t}` +
  `apply();if(m){if(m.addEventListener)m.addEventListener('change',apply);else if(m.addListener)m.addListener(apply)}` +
  `window.fpTheme={get:get,set:function(v){if(!ok(v))return;mem=v;try{localStorage.setItem(K,v)}catch(e){}apply()}}})();`;

// Logo / tab icon tags, shared by every page (layout pages and the start/not-found pages).
const ICON_TAGS = `<link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/favicon.svg">
  <meta name="theme-color" content="#E0A526">`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sidebar(key, active) {
  const items = TABS.map((t) => {
    const current = t.id === active;
    return `<li><a class="tab${current ? ' active' : ''}" href="/w/${esc(key)}${t.path}"${current ? ' aria-current="page"' : ''}>` +
      `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${t.icon}</svg>` +
      `<span>${esc(t.label)}</span></a></li>`;
  }).join('');
  return `<nav class="sidebar" aria-label="Main">` +
    `<a class="logo" href="/w/${esc(key)}" aria-label="Food Planner home"><img src="/favicon.svg" width="36" height="36" alt="Food Planner"></a>` +
    `<ul>${items}</ul></nav>`;
}

/**
 * @param {object} o
 * @param {string} o.key     workspace key (already validated)
 * @param {string} o.active  tab id: home | planner | kitchen | profile
 * @param {string} o.title   page title
 * @param {string} o.content trusted HTML for the page body
 * @param {string[]} [o.scripts] script URLs to load
 */
function renderPage({ key, active, title, content, scripts = [], bare = false }) {
  // bare: no sidebar (used for the first-run welcome flow)
  const body = bare
    ? `<div class="no-sidebar">
    <main class="page">
${content}
    </main>
  </div>`
    : `${sidebar(key, active)}
  <div class="with-sidebar">
    <main class="page">
${content}
    </main>
  </div>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="referrer" content="no-referrer">
  <meta name="color-scheme" content="light dark">
  ${ICON_TAGS}
  <script>${THEME_SCRIPT}</script>
  <script>try{localStorage.setItem('fp_workspace',${JSON.stringify(String(key))})}catch(e){}</script>
  <title>${esc(title)} · Food Planner</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  ${body}
${scripts.map((s) => `  <script src="${esc(s)}"></script>`).join('\n')}
</body>
</html>`;
}

const placeholder = (heading) => `    <h1>${esc(heading)}</h1>
    <p class="eyebrow">Coming soon</p>`;

module.exports = { renderPage, placeholder, TABS, THEME_SCRIPT, ICON_TAGS };
