'use strict';

/* ---------- installer: `node server.js --install` (runs after npm install) ---------- */
if (process.argv.includes('--install')) {
  const fs = require('fs'), path = require('path'); // own requires: must work before dependencies are loaded
  const runtimeTemplates = {
    'supervisor.js': String.raw`'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const HOST = '127.0.0.1';
const SUPERVISOR_PORT = Number(process.env.SUPERVISOR_PORT) || 8001;
const DOWNLOADER_PORT = Number(process.env.DOWNLOADER_PORT) || 8000;
const SERVICE_NAME = 'download-that-stuff-supervisor.service';
const DOWNLOADER_URL = __TICK__http://__INTERP__{HOST}:__INTERP__{DOWNLOADER_PORT}/api/health__TICK__;
let downloader = null;
let starting = null;

function allowedOrigin(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    || /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin);
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && !allowedOrigin(origin)) {
    res.writeHead(403).end();
    return false;
  }
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  return true;
}

async function downloaderIsRunning() {
  try {
    const response = await fetch(DOWNLOADER_URL, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

function startDownloader() {
  if (starting) return starting;
  starting = (async () => {
    if (await downloaderIsRunning()) return { status: 'running' };
    if (downloader) return { status: 'starting' };

    const child = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(DOWNLOADER_PORT) },
      stdio: 'ignore'
    });
    downloader = child;
    child.once('error', error => {
      console.error('Could not start downloader:', error.message);
      if (downloader === child) downloader = null;
    });
    child.once('exit', () => {
      if (downloader === child) downloader = null;
    });
    return { status: 'starting' };
  })().finally(() => { starting = null; });
  return starting;
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    if (!setCors(req, res)) return;
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (req.method !== 'POST' || req.url !== '/api/start') return res.writeHead(404).end();

    try {
      const result = await startDownloader();
      res.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('Could not start downloader:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error' }));
    }
  });

  server.listen(SUPERVISOR_PORT, HOST, () => {
    console.log(__TICK__Downloader supervisor listening at http://__INTERP__{HOST}:__INTERP__{SUPERVISOR_PORT}__TICK__);
  });
  server.on('error', error => {
    console.error('Downloader supervisor failed:', error.message);
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (downloader) downloader.kill('SIGTERM');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

function installService() {
  const automaticInstall = process.env.npm_lifecycle_event === 'postinstall';
  const skipAutomaticInstall = message => {
    if (!automaticInstall) return false;
    console.log(__TICK__[supervisor] __INTERP__{message} Skipping automatic setup.__TICK__);
    return true;
  };
  if (process.platform !== 'linux') {
    if (skipAutomaticInstall('Systemd user services are only available on Linux.')) return;
    throw new Error('The user-service installer currently supports Linux only.');
  }
  try {
    execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
  } catch {
    const message = 'No active systemd user session was found.';
    if (skipAutomaticInstall(message)) return;
    throw new Error(__TICK____INTERP__{message} Run this command from your logged-in desktop session.__TICK__);
  }

  const serviceDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
  fs.mkdirSync(serviceDir, { recursive: true });
  const quote = value => __TICK__"__INTERP__{String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"__TICK__;
  const escapePath = value => String(value).replaceAll('\\', '\\x5c').replaceAll(' ', '\\x20').replaceAll('%', '%%');
  const unit = [
    '[Unit]',
    'Description=Download that Stuff local supervisor',
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    __TICK__WorkingDirectory=__INTERP__{escapePath(__dirname)}__TICK__,
    __TICK__Environment=PATH=__INTERP__{quote(process.env.PATH || '/usr/bin:/bin')}__TICK__,
    __TICK__ExecStart=__INTERP__{quote(process.execPath)} __INTERP__{quote(__filename)}__TICK__,
    'Restart=on-failure',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
  const unitPath = path.join(serviceDir, SERVICE_NAME);
  fs.writeFileSync(unitPath, unit);
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'enable', '--now', SERVICE_NAME], { stdio: 'inherit' });
  console.log('Downloader supervisor installed and enabled for this user.');
}

if (process.argv.includes('--install')) {
  try {
    installService();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else {
  startServer();
}
`.replaceAll('__TICK__', '`').replaceAll('__INTERP__', '$'),
    'sw.js': String.raw`'use strict';

const CACHE_NAME = 'download-that-stuff-shell-v1';
const SHELL_URL = new URL('./', self.location.href).pathname;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.add(SHELL_URL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const oldCaches = (await caches.keys()).filter(name => name.startsWith('download-that-stuff-shell-') && name !== CACHE_NAME);
    await Promise.all(oldCaches.map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(SHELL_URL, response.clone());
      }
      return response;
    } catch {
      return await caches.match(SHELL_URL) || Response.error();
    }
  })());
});
`
  };
  for (const [name, template] of Object.entries(runtimeTemplates)) {
    fs.writeFileSync(path.join(__dirname, name), template);
    console.log(`[install] Generated ${name}`);
  }
  const installYtdlp = async () => {
    const { platform, arch } = process;
    const asset = platform === 'win32' ? (arch === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe')
      : platform === 'darwin' ? 'yt-dlp_macos'
      : platform === 'linux' ? ({ x64: 'yt-dlp_linux', arm64: 'yt-dlp_linux_aarch64', arm: 'yt-dlp_linux_armv7l' })[arch] : null;
    const dest = path.join(__dirname, 'bin', platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    if (!asset) return console.warn(`[install] No prebuilt yt-dlp for ${platform}/${arch}. Install it manually and set YTDLP=/path/to/yt-dlp.`);
    if (fs.existsSync(dest)) return console.log('[install] yt-dlp already present, skipping.');
    console.log(`[install] Downloading yt-dlp (${asset})...`);
    const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
    fs.chmodSync(dest + '.part', 0o755); fs.renameSync(dest + '.part', dest);
    console.log('[install] yt-dlp installed to', dest);
  };
  (async () => {
    try { await installYtdlp(); } catch (e) { console.warn(`[install] Could not download yt-dlp (${e.message}). Retry with: npm run install-tools`); }
  })().finally(() => process.exit(0));
  return; // don't start the server
}
// Node.js downloader backend. `npm install` runs `node server.js --install`, which downloads yt-dlp into ./bin;
// ffmpeg comes from the ffmpeg-static package. YTDLP / FFMPEG env vars or copies on PATH still work.
const express = require('express'), http = require('http'), { WebSocketServer } = require('ws');
const fs = require('fs'), os = require('os'), path = require('path');
const fsp = fs.promises;
const { spawn, execFile } = require('child_process');

const HOST = '127.0.0.1', PORT = +process.env.PORT || 8000;
const ORIGIN = process.env.ALLOW_ORIGIN || '*';           // e.g. https://you.github.io
const LOCAL_YTDLP = path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP = process.env.YTDLP || (fs.existsSync(LOCAL_YTDLP) ? LOCAL_YTDLP : 'yt-dlp');
let FFMPEG = process.env.FFMPEG || '';
if (!FFMPEG && process.platform === 'linux' && fs.existsSync('/usr/bin/ffmpeg')) FFMPEG = '/usr/bin/ffmpeg';
if (!FFMPEG) { try { FFMPEG = require('ffmpeg-static') || ''; } catch {} }
if (!FFMPEG || !fs.existsSync(FFMPEG)) FFMPEG = 'ffmpeg';
const CONNS = Math.min(16, Math.max(1, +process.env.CONNECTIONS || 16)); // parallel connections per download
const EMBED_VIDEO = process.env.EMBED_VIDEO === '1'; // thumbnail/tag embedding rewrites the whole video file: off = much faster
const USE_ARIA2 = process.env.ARIA2 !== '0';                            // auto-used when aria2c is installed
const MAX_JOBS = Math.max(1, +process.env.MAX_JOBS || 8); // parallel downloads
const DL = path.join(__dirname, 'downloads'), CACHE = path.join(__dirname, 'cache.json');
const TMP = path.join(__dirname, 'tmp-browser'); // staging area for "browser only" downloads; wiped on start/exit (not /tmp: it is RAM-backed on many distros)

/* ---------- path safety ---------- */
// Download folders must live under these bases (default: home dir + ./downloads).
const BASES = [DL, os.homedir(), ...(process.env.ALLOW_DIRS || '').split(path.delimiter).filter(Boolean)].map(p => path.resolve(p));
const within = (base, p) => { const x = path.relative(base, p); return x === '' || (!x.startsWith('..') && !path.isAbsolute(x)); };
const allowedDir = p => BASES.some(b => within(b, p)) && path.dirname(p) !== p; // never a filesystem root
const real = p => { try { return fs.realpathSync(p); } catch { return p; } }; // resolves symlinks when the path exists

/* ---------- cache (JSON file, debounced atomic writes) ---------- */
let db = { roots: [], rows: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(CACHE, 'utf8')) }; } catch {}
const roots = new Set([DL, TMP, ...db.roots.map(r => path.resolve(r)).filter(allowedDir)]);
let saveTimer, writing = false, again = false;
const snapshot = () => JSON.stringify({ roots: [...roots].filter(r => r !== TMP), rows: db.rows });
async function saveNow() { // async so a big cache never blocks the event loop; writes never overlap
  if (writing) { again = true; return; }
  writing = true;
  try { await fsp.writeFile(CACHE + '.tmp', snapshot()); await fsp.rename(CACHE + '.tmp', CACHE); }
  catch (e) { console.error('cache write failed:', e.message); }
  finally { writing = false; if (again) { again = false; saveNow(); } }
}
function flushDb() { // synchronous: only used on shutdown
  clearTimeout(saveTimer);
  try { fs.writeFileSync(CACHE + '.tmp', snapshot()); fs.renameSync(CACHE + '.tmp', CACHE); }
  catch (e) { console.error('cache write failed:', e.message); }
}
const saveDb = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); };
const MAX_CACHE_ROWS = 500;
function trimCache() {
  const keys = Object.keys(db.rows), excess = keys.length - MAX_CACHE_ROWS;
  if (excess <= 0) return false;
  for (let i = 0; i < excess; i++) delete db.rows[keys[i]];
  return true;
}
if (trimCache()) saveDb();

/* ---------- helpers ---------- */
let realRoots = []; // realpath of every root, computed once instead of on every request
const refreshRoots = () => { realRoots = [...roots].map(real); };
refreshRoots();
const inRoots = p => { const r = real(p); return realRoots.some(b => within(b, r) && r !== b); };
const isFile = p => fsp.stat(p).then(st => st.isFile(), () => false);
const ah = fn => (q, r, n) => fn(q, r, n).catch(n); // forward async handler errors to the error middleware
const ephemeral = new Map(); // file path -> { dir, t }: browser-only downloads waiting in TMP to be picked up by the browser
const rmJob = dir => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
const discard = p => { const e = ephemeral.get(p); if (e) { ephemeral.delete(p); rmJob(e.dir); } };
function urlPath(u) { // stored file URL -> absolute path (pure string work, no disk access)
  try {
    const x = new URL(u), q = x.searchParams.get('path');
    return q ? path.resolve(q) : x.pathname.startsWith('/downloads/') ? path.resolve(DL, decodeURIComponent(x.pathname.slice(11))) : null;
  } catch { return null; }
}
function localPath(u) { const a = urlPath(u); return a && inRoots(a) ? a : null; } // safe path (only inside download folders)
function normDir(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return DL;
  let c = raw.trim().replace(/"/g, '');
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(c)) return DL; // Windows path on a non-Windows host
  if (c === '~' || c.startsWith('~/') || c.startsWith('~\\')) c = path.join(os.homedir(), c.slice(1));
  const a = path.resolve(c);
  if (!allowedDir(a)) throw new Error('That folder isn\u2019t allowed. Pick a folder inside your home directory.');
  if (fs.mkdirSync(a, { recursive: true })) refreshRoots(); // creates the folder only now; returns the first folder it made (undefined if it already existed)
  if (!roots.has(a)) { roots.add(a); refreshRoots(); saveDb(); }
  return a;
}
const isUrl = u => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };
const MISSING = 'yt-dlp isn\u2019t installed. Run "npm run install-tools" (or set YTDLP=/path/to/yt-dlp), then restart the server.';
const esc = s => s.replace(/%/g, '%%'); // literal % in a folder name must not act as a yt-dlp template field
const folderName = t => String(t || '').replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120) || 'Playlist'; // safe single folder name
const fmtSpeed = v => (Number.isFinite(+v) && +v > 0 ? (+v / 1048576).toFixed(2) + ' MiB/s' : '');
const fmtEta = v => { const n = +v; if (!Number.isFinite(n)) return '?'; return n >= 60 ? `${Math.floor(n / 60)}m ${Math.round(n % 60)}s` : `${Math.round(n)}s`; };

// Tiny job queue so a burst of requests can't spawn unlimited yt-dlp/ffmpeg processes.
let active = 0; const waiting = [];
const acquire = () => active < MAX_JOBS ? (active++, Promise.resolve()) : new Promise(r => waiting.push(r));
const release = () => { const n = waiting.shift(); n ? n() : active--; };

/* ---------- HTTP API ---------- */
const app = express();
app.disable('x-powered-by');
const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(HOST);
app.use((req, res, next) => { // block DNS-rebinding: local-only servers only answer to local host names
  if (loopback && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '')) return res.sendStatus(403);
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '86400' }); // max-age: browsers cache the preflight
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/downloads', express.static(DL, { index: false }));
app.get('/', (q, r) => r.sendFile(path.join(__dirname, 'index.html')));
app.get('/sw.js', (q, r) => { r.set('Cache-Control', 'no-cache'); r.sendFile(path.join(__dirname, 'sw.js')); });
app.get('/api/health', (q, r) => r.json({ status: 'ok', msg: 'Backend is running', tools }));

app.get('/api/file', (req, res) => {
  const p = path.resolve(String(req.query.path || ''));
  if (!inRoots(p)) return res.status(404).json({ detail: 'File not found' });
  const done = err => { // no separate stat: sendFile stats anyway
    if (err) { if (!res.headersSent) res.status(404).json({ detail: 'File not found' }); return; }
    if (req.method === 'GET' && req.query.download && res.statusCode === 200) discard(p); // browser-only file fully delivered: remove the temp copy
  };
  req.query.download ? res.download(p, done) : res.sendFile(p, done); // sendFile handles Range requests, so seeking works
});
app.get('/api/zip', (req, res) => { // browser-only playlists: everything downloaded for one playlist, zipped into a single folder
  const id = String(req.query.group || '');
  const jobs = /^[\w-]{6,64}$/.test(id) ? [...new Set([...ephemeral.values()].filter(e => e.group === id).map(e => e.dir))] : [];
  if (!jobs.length) return res.status(404).json({ detail: 'Nothing to zip' });
  let archiver; try { archiver = require('archiver'); } catch { return res.status(500).json({ detail: 'The archiver package is missing. Run "npm install" and restart the server.' }); }
  const name = folderName(req.query.name);
  const archive = archiver('zip', { store: true }); // media is already compressed: store it instead of wasting CPU
  archive.on('warning', e => console.warn('zip:', e.message));
  archive.on('error', () => res.destroy());
  res.attachment(name + '.zip');
  archive.pipe(res);
  for (const d of jobs) archive.directory(d, name); // the playlist's name becomes the folder inside the zip
  archive.finalize();
  res.on('finish', () => { for (const [p, e] of [...ephemeral]) if (e.group === id) discard(p); }); // delivered: remove the temp copies
});
app.post('/api/file_exists', ah(async (q, r) => {
  const p = localPath(q.body.filepath);
  r.json({ status: 'ok', exists: !!p && await isFile(p) });
}));
app.post('/api/delete_file', ah(async (q, r) => {
  const p = localPath(q.body.filepath);
  if (p && await isFile(p)) {
    await fsp.unlink(p);
    for (let d = path.dirname(p); !roots.has(d) && inRoots(d); d = path.dirname(d)) { // prune empty parents up to the root
      try { if ((await fsp.readdir(d)).length) break; await fsp.rmdir(d); } catch { break; }
    }
    for (const k in db.rows) if (urlPath(db.rows[k].url) === p) delete db.rows[k]; // string compare only, no disk access per row
    saveDb();
  }
  r.json({ status: 'ok' });
}));
app.post('/api/open_location', ah(async (q, r) => {
  const p = localPath(q.body.filepath);
  if (p && await isFile(p)) {
    const [cmd, args] = process.platform === 'win32' ? ['explorer', ['/select,' + p]]
      : process.platform === 'darwin' ? ['open', ['-R', p]] : ['xdg-open', [path.dirname(p)]];
    const c = spawn(cmd, args, { stdio: 'ignore', detached: true }); c.on('error', () => {}); c.unref();
  }
  r.json({ status: 'ok' });
}));
app.post('/api/browse_directory', (q, r) => r.json({ status: 'error', msg: 'No folder picker here. Type the folder path instead.' }));
app.post('/api/clear_cache', (q, r) => { db.rows = {}; saveDb(); r.json({ status: 'ok' }); });

const plCache = new Map(); // url -> { t, playlist }: re-opening the same playlist skips a slow yt-dlp run
const PL_TTL = 5 * 60 * 1000, PL_MAX = 20;
app.post('/api/playlist_info', (req, res) => {
  const url = req.body.url;
  if (!isUrl(url)) return res.status(400).json({ detail: 'That doesn\u2019t look like a link' });
  const hit = plCache.get(url);
  if (hit && Date.now() - hit.t < PL_TTL) return res.json({ status: 'ok', playlist: hit.playlist });
  let gone = false;
  const child = execFile(YTDLP, ['--flat-playlist', '-J', '--ignore-errors', '--', url], { maxBuffer: 1 << 28, timeout: 60000 }, (err, out) => {
    if (gone) return;
    if (err && err.code === 'ENOENT') return res.status(500).json({ detail: MISSING });
    if (err && err.killed) return res.status(504).json({ detail: 'Timed out reading the playlist' });
    let info; try { info = JSON.parse(out); } catch { return res.status(400).json({ detail: 'Could not extract playlist info' }); }
    const seen = new Set();
    const entries = (info.entries || []).filter(Boolean).map((e, i) => {
      const u = [e.webpage_url, e.url].find(isUrl) || (e.id && /^[\w-]{11}$/.test(e.id) ? `https://www.youtube.com/watch?v=${e.id}` : null);
      return { id: String(e.id || i + 1), index: i + 1, title: e.title || `Untitled #${i + 1}`, url: u,
        thumbnail: e.thumbnail || e.thumbnails?.[0]?.url || '',
        duration: e.duration_string || (e.duration != null ? e.duration + 's' : '?:??'), uploader: e.uploader || info.uploader || '', available: !!u };
    }).filter(e => !e.url || !seen.has(e.url) && seen.add(e.url)); // drop duplicate entries
    if (!entries.length) return res.status(400).json({ detail: 'No downloadable playlist entries found' });
    const playlist = { title: info.title || 'Untitled Playlist', uploader: info.uploader || '', entryCount: entries.length, entries };
    plCache.delete(url); plCache.set(url, { t: Date.now(), playlist });
    if (plCache.size > PL_MAX) plCache.delete(plCache.keys().next().value); // evict the oldest
    res.json({ status: 'ok', playlist });
  });
  res.on('close', () => { if (!res.writableEnded) { gone = true; child.kill(); } }); // client gave up: stop yt-dlp
});
app.use((err, q, res, n) => res.status(err.status || 500).json({ detail: err.type === 'entity.parse.failed' ? 'Bad JSON' : 'Server error' }));

/* ---------- yt-dlp argument builder ---------- */
function buildArgs({ url, type, ext, q, s, dir, recode, resolution = 'best' }) {
  const fragmentConnections = Math.min(32, CONNS * 2);
  const a = ['--quiet', '--no-simulate', '--progress', '--newline', '--no-playlist', '--no-warnings',
    ...(FFMPEG !== 'ffmpeg' ? ['--ffmpeg-location', FFMPEG] : []),
    '-N', String(fragmentConnections), '--http-chunk-size', '10M', '--buffer-size', '256K', '--no-mtime', '--retries', '5', '--fragment-retries', '5',
    '--progress-template', 'download:PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '--print', 'after_move:DONE\t%(filepath)s\t%(title)s\t%(thumbnail)s\t%(duration_string)s'];
  if (USE_ARIA2 && tools.aria2c) // multi-connection downloader for plain HTTP streams; fragmented HLS/DASH stays native
    a.push('--downloader', 'aria2c', '--downloader', 'dash,m3u8:native', '--downloader-args', `aria2c:-x ${Math.min(16, fragmentConnections)} -s ${Math.min(16, fragmentConnections)} -k 1M --min-split-size=1M --file-allocation=none`);
  if (type === 'audio_only') {
    // "fast": grab a small (<=128 kbps) stream when one exists and skip the cover-art download/embed pass
    a.push('-f', q === 'fast' ? 'bestaudio[abr<=130]/bestaudio/best' : 'bestaudio/best', '-x', '--audio-format', ext === 'ogg' ? 'vorbis' : ext); // yt-dlp calls .ogg audio "vorbis"
    if (!['wav', 'flac'].includes(ext)) a.push('--audio-quality', q === 'fast' ? '128' : q);
  } else {
    const height = resolution === 'best' ? '' : `[height<=${resolution}]`;
    const f = type === 'video_only' ? `bestvideo[ext=${ext}]${height}/bestvideo${height}/best${height}`
      : ext === 'webm' ? `bestvideo[ext=webm]${height}+bestaudio[ext=webm]/bestvideo[ext=webm]${height}+bestaudio/best[ext=webm]${height}/best${height}`
      : `bestvideo[ext=${ext}]${height}+bestaudio[ext=m4a]/bestvideo[ext=${ext}]${height}+bestaudio/best[ext=${ext}]${height}/best${height}`;
    // Remux (fast, lossless copy) first; only re-encode as a fallback when remuxing fails.
    a.push('-f', f, '--merge-output-format', ext, recode ? '--recode-video' : '--remux-video', ext);
  }
  // Audio files are small, so tagging them is cheap. Videos skip the extra full-file ffmpeg passes unless EMBED_VIDEO=1.
  if (type === 'audio_only' || EMBED_VIDEO) a.push('--embed-metadata');
  if (type === 'audio_only' ? q !== 'fast' && ['mp3', 'm4a', 'ogg', 'flac'].includes(ext) : EMBED_VIDEO && ['mp4', 'mkv', 'mov', 'm4v'].includes(ext)) a.push('--write-thumbnail', '--embed-thumbnail');
  if (s.extractSubtitles) a.push('--write-subs', '--write-auto-subs', '--sub-langs', 'en');
  if (s.downloadMetadata) a.push('--write-description', '--write-info-json');
  let o = esc(dir.replace(/\\/g, '/')) + '/';
  if (s.organizeTypes) o += type === 'audio_only' ? 'Audio/' : 'Video/';
  if (s.organizeChannel) o += '%(uploader)s/';
  a.push('-o', o + '%(title).150B.%(ext)s', '--', url); // .150B keeps very long titles under filesystem name limits
  return a;
}

/* ---------- WebSocket download ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/download', maxPayload: 64 * 1024, perMessageDeflate: false });
const children = new Set();
const killTree = c => { // kill yt-dlp and whatever it spawned (ffmpeg/aria2c) so a cancelled download stops using CPU
  if (c.exitCode !== null || c.signalCode !== null) return;
  try { process.platform === 'win32' ? c.kill() : process.kill(-c.pid, 'SIGTERM'); } catch { try { c.kill(); } catch {} }
};

wss.on('connection', (ws, req) => {
  if (ORIGIN !== '*' && req.headers.origin && req.headers.origin !== ORIGIN) return ws.close();
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  let child, closed = false, slot = false;
  ws.on('error', () => {}); // e.g. oversized message: ws closes the socket itself; an unhandled 'error' event would crash the server
  ws.on('close', () => { closed = true; child && killTree(child); });
  const idle = setTimeout(() => ws.close(), 15000); // no request sent -> hang up
  send({ status: 'connected', msg: 'Connected' });

  ws.once('message', async raw => {
    clearTimeout(idle);
    try { await download(JSON.parse(raw)); }
    catch (e) { send({ status: 'error', msg: e.message }); ws.close(); }
    finally { if (slot) release(); }
  });

  function run(args) {
    return new Promise((resolve, reject) => {
      let file, err = '', buf = '', lastGot = 0, stage = 0, lastSend = 0;
      const c = child = spawn(YTDLP, args, { detached: process.platform !== 'win32' }); children.add(c); // own process group so killTree reaches ffmpeg/aria2c
      c.on('error', e => { children.delete(c); reject(new Error(e.code === 'ENOENT' ? MISSING : e.message)); });
      c.stderr.setEncoding('utf8'); c.stdout.setEncoding('utf8'); // per-chunk Buffer->string would garble multi-byte titles split across chunks
      c.stderr.on('data', d => { err = (err + d).slice(-4000); });
      c.stdout.on('data', d => {
        const lines = (buf + d).split('\n'); buf = lines.pop();
        for (const l of lines) {
          if (l.startsWith('PROG|')) {
            const [, got, t1, t2, sp, eta] = l.split('|'), tot = +t1 || +t2;
            const newStage = +got < lastGot; // a new stream (e.g. audio after video) started
            if (newStage) stage++;
            lastGot = +got;
            const now = Date.now();
            if (!newStage && now - lastSend < 250) continue; // ~4 updates/s is plenty for a progress bar
            lastSend = now;
            send({ status: 'downloading', percent: tot ? Math.min(99, got / tot * 100) : 0, stage,
              msg: `Downloading ${fmtSpeed(sp) || '...'}, ETA ${fmtEta(eta)}` });
          } else if (l.startsWith('DONE\t')) { const [, fp, title, thumb, dur] = l.split('\t'); file = { fp, title, thumb, dur }; }
        }
      });
      c.on('close', code => {
        children.delete(c);
        if (code === 0 && file) return resolve(file);
        const lines = err.trim().split('\n').filter(l => l.trim());
        reject(Object.assign(new Error((lines.reverse().find(l => /^ERROR/.test(l)) || lines[0] || `yt-dlp exited with code ${code}`).replace(/^ERROR:\s*/, '')), { full: err }));
      });
    });
  }

  async function download(req) {
    const { url, type = 'video_audio', settings: s = {}, group } = req;
    if (!isUrl(url)) throw new Error('That doesn\u2019t look like a link.');
    if (!['video_audio', 'video_only', 'audio_only'].includes(type)) throw new Error('Bad download type.');
    const ext = String(req.ext || (type === 'audio_only' ? 'mp3' : 'mp4')).toLowerCase(), q = String(req.quality || '192');
    if (!/^[a-z0-9]{2,5}$/.test(ext) || !/^(\d+|best|fast)$/.test(q)) throw new Error('Bad format options.');
    const resolution = type === 'audio_only' ? 'best' : String(req.resolution || 'best');
    if (!/^(best|2160|1440|1080|720|480|360)$/.test(resolution)) throw new Error('Bad resolution option.');
    const toBrowser = !!s.autoBrowser; // "browser only": stage in a private temp folder, hand the file to the browser, then delete it
    const gid = group && /^[\w-]{6,64}$/.test(String(group.id)) ? String(group.id) : null; // set when this download is part of a playlist
    const base0 = toBrowser ? TMP : normDir(s.downloadDirectory);
    const dir = gid && !toBrowser ? path.join(base0, folderName(group.title)) : base0; // saving to disk: playlist items go into a folder named after the playlist
    const useCache = s.useCache !== false && !toBrowser; // temp files are deleted after sending, so they are never cached
    const k = [url, type, q, ext, resolution, dir, !!s.extractSubtitles, !!s.downloadMetadata].join('|'); // settings that change the output are part of the key

    if (useCache && db.rows[k]) {
      const p = localPath(db.rows[k].url);
      if (p && await isFile(p)) {
        send({ status: 'progress', msg: 'Found in cache', percent: 100 });
        send({ status: 'completed', msg: 'Served from cache', file: db.rows[k] });
        return ws.close();
      }
      delete db.rows[k]; saveDb(); // stale entry
    }

    if (active >= MAX_JOBS) send({ status: 'starting', msg: `Queued (${waiting.length + 1} waiting)` });
    await acquire(); slot = true;
    if (closed) return; // client left while queued

    let jobDir = null, keep = false; // browser-only: each job gets its own temp folder, removed unless it is handed to the browser
    try {
      if (toBrowser) jobDir = await fsp.mkdtemp(path.join(TMP, 'job-'));
      send({ status: 'starting', msg: 'Starting download' });
      const base = { url, type, ext, q, s, dir: jobDir || dir, resolution };
      let r;
      try { r = await run(buildArgs({ ...base, recode: false })); }
      catch (e) {
        const canRecode = !closed && type !== 'audio_only' && /remux|postprocess|ffmpeg|conversion|container/i.test(e.full || e.message);
        if (!canRecode) throw e;
        send({ status: 'starting', msg: 'Remux failed, converting instead (slower)' });
        r = await run(buildArgs({ ...base, recode: true }));
      }

      const na = v => (!v || v === 'NA' ? '' : v);
      const fp = path.resolve(r.fp);
      const file = { title: r.title, thumbnail: na(r.thumb), duration: na(r.dur), type,
        url: `http://localhost:${PORT}/api/file?path=${encodeURIComponent(fp)}` };
      if (toBrowser) { ephemeral.set(fp, { dir: jobDir, t: Date.now(), group: gid }); keep = true; }
      else if (useCache) { db.rows[k] = file; trimCache(); saveDb(); }
      send({ status: 'completed', msg: 'All done', file });
    } finally { if (jobDir && !keep) rmJob(jobDir); }
    ws.close();
  }
});

/* ---------- startup / shutdown ---------- */
const tools = { ytdlp: false, ffmpeg: false, aria2c: false };
const probe = (cmd, args, key) => execFile(cmd, args, { timeout: 5000 }, e => { tools[key] = !e; });
probe(YTDLP, ['--version'], 'ytdlp'); probe(FFMPEG, ['-version'], 'ffmpeg'); probe('aria2c', ['--version'], 'aria2c');
setTimeout(() => {
  if (!tools.ytdlp) console.warn('! yt-dlp not found (run: npm run install-tools, or set YTDLP=/path/to/yt-dlp)');
  if (USE_ARIA2 && !tools.aria2c) console.warn('i aria2c not found: using yt-dlp native downloads; aria2c is optional.');
  if (!tools.ffmpeg) console.warn('! ffmpeg not found (run npm install, or set FFMPEG=/path/to/ffmpeg): merging and audio conversion will fail');
}, 1500).unref();

const shutdown = () => { flushDb(); children.forEach(killTree); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
const startupError = e => {
  console.error(e.code === 'EADDRINUSE'
    ? `Local server is already running at http://${HOST}:${PORT}. Stop it before starting another copy.`
    : e.message);
  process.exit(1);
};
server.on('error', startupError);
wss.on('error', startupError);
server.listen(PORT, HOST, () => {
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true }); // start clean; only after listen succeeds so a second instance can't wipe a running one
  refreshRoots(); // TMP exists now, so its realpath is final
  process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
  setInterval(() => { for (const [p, e] of ephemeral) if (Date.now() - e.t > 3600e3) discard(p); }, 600e3).unref(); // drop files the browser never picked up
  console.log(`Downloader running at http://${HOST}:${PORT}`);
});