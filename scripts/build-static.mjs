// Builds dist/: a static, server-free copy of the prototype for hosting as a
// clickable page. A fetch shim (mock-api.js) answers the app's /api calls with
// the same mock responses server.js gives in demo mode. Run with the server up:
//   ATHENA_EMBED_PORT=8100 node server.js &  node scripts/build-static.mjs
import fs from 'fs';
import path from 'path';
const BASE = process.env.BASE || 'http://localhost:8100';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'js'), { recursive: true });
fs.mkdirSync(path.join(dist, 'css'), { recursive: true });
fs.mkdirSync(path.join(dist, 'fonts'), { recursive: true });

const get = async (u) => (await fetch(BASE + u)).json();
const patient = await get('/api/patient/P-100242?encounterId=E-558843');
const medicaid = await get('/api/medicaid-renewal/P-100242');

const shim = `/* Static build: answers the prototype's /api calls in the browser (no server). */
(function () {
  var PATIENT = ${JSON.stringify(patient)};
  var MEDICAID = ${JSON.stringify(medicaid)};
  function json(status, body) {
    return Promise.resolve(new Response(JSON.stringify(body), { status: status, headers: { 'Content-Type': 'application/json' } }));
  }
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url;
    var u = new URL(url, window.location.href);
    var p = u.pathname.replace(/^.*?(\\/api\\/)/, '/api/');
    var m = ((init && init.method) || 'GET').toUpperCase();
    if (p.indexOf('/api/') !== 0) return realFetch(input, init);
    if (m === 'GET' && /^\\/api\\/patient\\/[^/]+$/.test(p)) return json(200, PATIENT);
    if (m === 'GET' && /^\\/api\\/medicaid-renewal\\/[^/]+$/.test(p)) {
      var copy = JSON.parse(JSON.stringify(MEDICAID)); copy.fetchedAt = new Date().toISOString(); return json(200, copy);
    }
    if (m === 'POST' && /^\\/api\\/medicaid-renewal\\/[^/]+\\/actions\\//.test(p)) return json(200, { ok: true, simulated: true });
    if (m === 'POST' && (p === '/api/patient/demographics' || p === '/api/patient/insurance'))
      return json(409, { error: 'live_lane_not_configured', message: 'Prototype: posting is simulated.' });
    return json(404, { error: 'not_in_prototype', message: 'Not part of the NextGen prototype.' });
  };
})();
`;
fs.writeFileSync(path.join(dist, 'js', 'mock-api.js'), shim);

let html = fs.readFileSync(path.join(root, 'views', 'index.html'), 'utf8');
html = html.replace('/public/app-icon.png', 'app-icon.png')
  .replace('/public/css/styles.css', 'css/styles.css')
  .replace('<script src="/public/js/athenaMessaging.js"></script>', '<script src="js/mock-api.js"></script>\n  <script src="js/athenaMessaging.js"></script>')
  .replace('/public/js/app.js', 'js/app.js')
  .replace('/public/js/nextgenStates.js', 'js/nextgenStates.js');
fs.writeFileSync(path.join(dist, 'index.html'), html);

let css = fs.readFileSync(path.join(root, 'public/css/styles.css'), 'utf8').replaceAll('/public/fonts/', '../fonts/');
fs.writeFileSync(path.join(dist, 'css', 'styles.css'), css);

let app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const before = app;
// Hosted page is always framed; force demo mode so it shows the mock patient.
app = app.replace('demo: forceDemo ? true : undefined,', 'demo: true,');
if (app === before) throw new Error('demo-mode patch did not apply');
fs.writeFileSync(path.join(dist, 'js', 'app.js'), app);
for (const f of ['athenaMessaging.js', 'nextgenStates.js']) fs.copyFileSync(path.join(root, 'public/js', f), path.join(dist, 'js', f));
for (const f of fs.readdirSync(path.join(root, 'public/fonts'))) if (f.endsWith('.woff2')) fs.copyFileSync(path.join(root, 'public/fonts', f), path.join(dist, 'fonts', f));
fs.copyFileSync(path.join(root, 'public/app-icon.png'), path.join(dist, 'app-icon.png'));
console.log('dist/ built');
