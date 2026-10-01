'use strict';

/* ---------- installer: `node server.js --install` (runs after npm install) ---------- */
if (process.argv.includes('--install')) {
  const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process'); // own requires: must work before dependencies are loaded
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
  const installAria2 = () => { // multi-connection downloader: makes downloads much faster (Arch/Omarchy: pacman)
    if (process.platform !== 'linux' || process.env.ARIA2 === '0') return;
    const has = cmd => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
    if (has('aria2c')) return console.log('[install] aria2c already installed, skipping.');
    if (!has('pacman')) return console.warn('[install] pacman not found. Install aria2 with your package manager for faster downloads.');
    console.log('[install] Installing aria2 (sudo pacman -S aria2), you may be asked for your password...');
    const r = spawnSync('sudo', ['pacman', '-S', '--needed', '--noconfirm', 'aria2'], { stdio: 'inherit' });
    if (r.status !== 0) console.warn('[install] Could not install aria2. Run it yourself: sudo pacman -S aria2');
  };
  (async () => {
    try { await installYtdlp(); } catch (e) { console.warn(`[install] Could not download yt-dlp (${e.message}). Retry with: npm run install-tools`); }
    try { installAria2(); } catch (e) { console.warn(`[install] aria2 step failed (${e.message})`); }
  })().finally(() => process.exit(0));
  return; // don't start the server
}
// Node.js downloader backend. `npm install` runs `node server.js --install`, which downloads yt-dlp into ./bin;
// ffmpeg comes from the ffmpeg-static package. YTDLP / FFMPEG env vars or copies on PATH still work.
const express = require('express'), http = require('http'), { WebSocketServer } = require('ws');
const fs = require('fs'), os = require('os'), path = require('path');
const fsp = fs.promises;
const { spawn, execFile } = require('child_process');
const { pipeline } = require('stream/promises');

const HOST = '127.0.0.1', PORT = +process.env.PORT || 8000;
const APP_VERSION = require('./package.json').version;
const ORIGIN = process.env.ALLOW_ORIGIN || '*';           // e.g. https://you.github.io
const LOCAL_YTDLP = path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP = process.env.YTDLP || (fs.existsSync(LOCAL_YTDLP) ? LOCAL_YTDLP : 'yt-dlp');
let FFMPEG = process.env.FFMPEG || '';
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
app.get('/api/health', (q, r) => r.json({ status: 'ok', msg: 'Backend is running', tools, version: APP_VERSION, update: latestRelease }));

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
/* ---------- editor: trim / cut with ffmpeg ---------- */
const fileUrlFor = p => `http://localhost:${PORT}/api/file?path=${encodeURIComponent(p)}`;
const NOFF = 'ffmpeg isn\u2019t installed. Run "npm install" (or set FFMPEG=/path/to/ffmpeg), then restart the server.';
const fmtDur = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

// A file picked in the editor is streamed into its own temp folder (wiped on exit, like browser-only downloads).
app.post('/api/edit_upload', ah(async (req, res) => {
  const ext = String(req.query.ext || '').toLowerCase();
  if (!/^[a-z0-9]{2,5}$/.test(ext)) return res.status(400).json({ detail: 'Unsupported file type' });
  const dir = await fsp.mkdtemp(path.join(TMP, 'edit-')), fp = path.join(dir, 'source.' + ext);
  try { await pipeline(req, fs.createWriteStream(fp)); }
  catch (e) { rmJob(dir); if (!res.headersSent) res.status(400).json({ detail: 'Upload interrupted' }); return; }
  ephemeral.set(fp, { dir, t: Date.now() });
  res.json({ status: 'ok', url: fileUrlFor(fp) });
}));

const probeMedia = p => new Promise((resolve, reject) => execFile(FFMPEG, ['-hide_banner', '-i', p], { timeout: 20000, maxBuffer: 1 << 24 }, (err, out, se) => {
  if (err && err.code === 'ENOENT') return reject(new Error(NOFF));
  const lines = String(se).split('\n').filter(l => /Stream #/.test(l));
  resolve({ video: lines.some(l => /Video:/.test(l) && !/attached pic/.test(l)), audio: lines.some(l => /Audio:/.test(l)) }); // cover art doesn't count as video
}));

function encArgs(ext, video) { // re-encode settings for "precise" mode, picked by output container
  if (video) return ext === 'webm'
    ? ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '5', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '160k']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', ...(['mp4', 'm4v', 'mov'].includes(ext) ? ['-movflags', '+faststart'] : [])];
  const aac = ['-c:a', 'aac', '-b:a', '192k'], opus = ['-c:a', 'libopus', '-b:a', '160k'], vorbis = ['-c:a', 'libvorbis', '-q:a', '5'];
  return ({ mp3: ['-c:a', 'libmp3lame', '-q:a', '2'], m4a: aac, aac, ogg: vorbis, oga: vorbis, opus, webm: opus, flac: ['-c:a', 'flac'], wav: ['-c:a', 'pcm_s16le'] })[ext] || aac;
}

function ffrun(args, onT, reg) { // one ffmpeg run; onT(seconds of output produced so far) drives the progress bar
  return new Promise((resolve, reject) => {
    const c = spawn(FFMPEG, ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', ...args], { detached: process.platform !== 'win32' });
    reg(c); children.add(c);
    let err = '', buf = '';
    c.on('error', e => { children.delete(c); reject(new Error(e.code === 'ENOENT' ? NOFF : e.message)); });
    c.stderr.setEncoding('utf8'); c.stdout.setEncoding('utf8');
    c.stderr.on('data', d => { err = (err + d).slice(-4000); });
    c.stdout.on('data', d => { const ls = (buf + d).split('\n'); buf = ls.pop(); for (const l of ls) { const m = /^out_time_(?:us|ms)=(\d+)/.exec(l); if (m) onT(+m[1] / 1e6); } });
    c.on('close', code => { children.delete(c); if (code === 0) return resolve(); const l = err.trim().split('\n').filter(Boolean); reject(new Error(l.pop() || `ffmpeg exited with code ${code}`)); });
  });
}

// body: { filepath, name, mode: 'precise'|'fast', segments: [[start, end], ...] }  (the parts to KEEP, in order)
// Streams newline-delimited JSON progress; the finished file is saved next to the source (or handed to the browser for uploads).
app.post('/api/edit', ah(async (req, res) => {
  const b = req.body || {};
  const src = localPath(b.filepath);
  if (!src || !(await isFile(src))) return res.status(404).json({ detail: 'That file is gone. Open it again.' });
  const segs = b.segments;
  if (!Array.isArray(segs) || !segs.length || segs.length > 500 || !segs.every(x => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite) && x[0] >= 0 && x[1] - x[0] > 0.01 && x[1] < 1e6))
    return res.status(400).json({ detail: 'Bad selection.' });
  const fast = b.mode === 'fast';
  res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = o => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
  let cur, gone = false, slot = false, work = null, madeDir = null, out = null, ok = false;
  res.on('close', () => { if (!res.writableEnded) { gone = true; cur && killTree(cur); } }); // client cancelled: stop ffmpeg
  const run = (args, onT) => ffrun(args, onT, c => { cur = c; });
  try {
    if (active >= MAX_JOBS) send({ status: 'working', percent: 0, msg: 'Waiting for other jobs' });
    await acquire(); slot = true;
    if (gone) return;
    const e0 = ephemeral.get(src); if (e0) e0.t = Date.now(); // keep an uploaded source alive while it is being edited
    send({ status: 'working', percent: 0, msg: 'Reading file' });
    const info = await probeMedia(src);
    if (!info.video && !info.audio) throw new Error('No audio or video found in that file.');
    const ext = (path.extname(src).slice(1) || 'mp4').toLowerCase();
    const inTmp = within(real(TMP), real(src));
    let outDir = path.dirname(src);
    if (inTmp) outDir = madeDir = await fsp.mkdtemp(path.join(TMP, 'edit-'));
    const stem = (inTmp ? folderName(b.name || 'Edited') : path.parse(src).name).replace(/ \(edited(?: \d+)?\)$/, '').slice(0, 150);
    for (let n = 1; ; n++) { out = path.join(outDir, `${stem} (edited${n > 1 ? ' ' + n : ''}).${ext}`); if (!fs.existsSync(out)) break; }
    const total = segs.reduce((t, [s, e]) => t + e - s, 0), F = n => n.toFixed(3);

    if (!fast) { // precise: trim every part and join them in one re-encode, so cuts land exactly where they were set
      const v = info.video, a = info.audio, flt = [];
      segs.forEach(([s, e], i) => {
        if (v) flt.push(`[0:v:0]trim=start=${F(s)}:end=${F(e)},setpts=PTS-STARTPTS[v${i}]`);
        if (a) flt.push(`[0:a:0]atrim=start=${F(s)}:end=${F(e)},asetpts=PTS-STARTPTS[a${i}]`);
      });
      flt.push(segs.map((_, i) => (v ? `[v${i}]` : '') + (a ? `[a${i}]` : '')).join('') + `concat=n=${segs.length}:v=${+v}:a=${+a}${v ? '[vc]' : ''}${a ? '[a]' : ''}`);
      if (v) flt.push('[vc]scale=trunc(iw/2)*2:trunc(ih/2)*2[v]'); // x264 needs even dimensions
      await run(['-i', src, '-filter_complex', flt.join(';'), ...(v ? ['-map', '[v]'] : []), ...(a ? ['-map', '[a]'] : []), ...encArgs(ext, v), out],
        t => send({ status: 'working', percent: Math.min(99, t / total * 100), msg: 'Cutting' }));
    } else { // fast: copy each part without re-encoding, then join; cuts snap to the nearest keyframe
      work = await fsp.mkdtemp(path.join(TMP, 'work-'));
      const maps = info.video ? ['-map', '0:v?', '-map', '0:a?'] : ['-map', '0:a'], parts = [];
      let done = 0;
      for (let i = 0; i < segs.length; i++) {
        const [s, e] = segs[i], pf = path.join(work, `p${i}.${ext}`), d = e - s, base = done;
        await run(['-ss', F(s), '-i', src, '-t', F(d), ...maps, '-c', 'copy', '-avoid_negative_ts', 'make_zero', pf],
          t => send({ status: 'working', percent: Math.min(95, (base + Math.min(t, d)) / total * 95), msg: 'Cutting' }));
        done += d; parts.push(pf);
      }
      if (parts.length === 1) await fsp.copyFile(parts[0], out);
      else {
        const list = path.join(work, 'list.txt');
        await fsp.writeFile(list, parts.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
        send({ status: 'working', percent: 96, msg: 'Joining parts' });
        await run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out], () => {});
      }
    }
    const fp = path.resolve(out);
    if (inTmp) ephemeral.set(fp, { dir: madeDir, t: Date.now() });
    ok = true;
    send({ status: 'completed', path: fp, browserOnly: inTmp,
      file: { title: path.parse(fp).name, thumbnail: '', duration: fmtDur(total), type: info.video ? 'video_audio' : 'audio_only', url: fileUrlFor(fp) } });
  } catch (e) { if (!gone) send({ status: 'error', msg: e.message }); }
  finally {
    if (work) rmJob(work);
    if (!ok) { if (madeDir) rmJob(madeDir); else if (out) fsp.rm(out, { force: true }).catch(() => {}); }
    if (slot) release();
    if (!res.writableEnded) res.end();
  }
}));

app.use((err, q, res, n) => res.status(err.status || 500).json({ detail: err.type === 'entity.parse.failed' ? 'Bad JSON' : 'Server error' }));

/* ---------- yt-dlp argument builder ---------- */
function buildArgs({ url, type, ext, q, s, dir, recode, resolution = 'best' }) {
  const a = ['--quiet', '--no-simulate', '--progress', '--newline', '--no-playlist', '--no-warnings',
    ...(FFMPEG !== 'ffmpeg' ? ['--ffmpeg-location', FFMPEG] : []),
    '-N', String(CONNS), '--http-chunk-size', '10M', '--buffer-size', '256K', '--no-mtime', '--retries', '5', '--fragment-retries', '5',
    '--progress-template', 'download:PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '--print', 'after_move:DONE\t%(filepath)s\t%(title)s\t%(thumbnail)s\t%(duration_string)s'];
  if (USE_ARIA2 && tools.aria2c) // multi-connection downloader for plain HTTP streams; fragmented HLS/DASH stays native
    a.push('--downloader', 'aria2c', '--downloader', 'dash,m3u8:native', '--downloader-args', `aria2c:-x ${CONNS} -s ${CONNS} -k 1M --min-split-size=1M --file-allocation=none`);
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
server.requestTimeout = 0; // editor uploads of big files can take longer than Node's default 5 minute limit
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
        const canRetry = !closed && type !== 'audio_only' && /remux|postprocess|ffmpeg|conversion|container/i.test(e.full || e.message);
        if (!canRetry) throw e;
        send({ status: 'starting', msg: 'Remux failed, converting instead (slower)' });
        r = await run(buildArgs({ ...base, recode: true }));
      }

      const na = v => (!v || v === 'NA' ? '' : v);
      const fp = path.resolve(r.fp);
      const file = { title: r.title, thumbnail: na(r.thumb), duration: na(r.dur), type,
        url: `http://localhost:${PORT}/api/file?path=${encodeURIComponent(fp)}` };
      if (toBrowser) { ephemeral.set(fp, { dir: jobDir, t: Date.now(), group: gid }); keep = true; }
      else if (useCache) { db.rows[k] = file; saveDb(); }
      send({ status: 'completed', msg: 'All done', file });
    } finally { if (jobDir && !keep) rmJob(jobDir); }
    ws.close();
  }
});

/* ---------- startup / shutdown ---------- */
const tools = { ytdlp: false, ffmpeg: false, aria2c: false };
let latestRelease = null;
const isNewerVersion = (candidate, current) => {
  const parts = value => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
    return match && match.slice(1).map(Number);
  };
  const candidateParts = parts(candidate), currentParts = parts(current);
  if (!candidateParts || !currentParts) return false;
  for (let index = 0; index < candidateParts.length; index++) {
    if (candidateParts[index] !== currentParts[index]) return candidateParts[index] > currentParts[index];
  }
  return false;
};
async function checkForUpdate() {
  try {
    const response = await fetch('https://api.github.com/repos/wwoooho2-gif/YTDownloader/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'YTDownloader-update-check' },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return;
    const release = await response.json();
    const version = String(release.tag_name || '').replace(/^v/, '');
    if (!isNewerVersion(version, APP_VERSION) || !/^https:\/\/github\.com\//.test(release.html_url || '')) {
      latestRelease = null;
      return;
    }
    latestRelease = { version, url: release.html_url };
  } catch {}
}
checkForUpdate();
setInterval(checkForUpdate, 24 * 60 * 60 * 1000).unref();
const probe = (cmd, args, key) => execFile(cmd, args, { timeout: 5000 }, e => { tools[key] = !e; });
probe(YTDLP, ['--version'], 'ytdlp'); probe(FFMPEG, ['-version'], 'ffmpeg'); probe('aria2c', ['--version'], 'aria2c');
setTimeout(() => {
  if (!tools.ytdlp) console.warn('! yt-dlp not found (run: npm run install-tools, or set YTDLP=/path/to/yt-dlp)');
  if (USE_ARIA2 && !tools.aria2c) console.warn('i aria2c not found: downloads use a single connection. Install it for multi-connection speed (Arch: sudo pacman -S aria2)');
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