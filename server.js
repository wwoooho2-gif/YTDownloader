'use strict';
// Node.js downloader backend. Needs yt-dlp and ffmpeg installed and on PATH.
const express = require('express'), http = require('http'), { WebSocketServer } = require('ws');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn, execFile } = require('child_process');

const HOST = process.env.HOST || '127.0.0.1', PORT = +process.env.PORT || 8000;
const ORIGIN = process.env.ALLOW_ORIGIN || '*';           // e.g. https://you.github.io
const YTDLP = process.env.YTDLP || 'yt-dlp';
const CONNS = Math.min(16, Math.max(1, +process.env.CONNECTIONS || 16)); // parallel connections per download
const EMBED_VIDEO = process.env.EMBED_VIDEO === '1'; // thumbnail/tag embedding rewrites the whole video file: off = much faster
const USE_ARIA2 = process.env.ARIA2 !== '0';                            // auto-used when aria2c is installed
const MAX_JOBS = Math.max(1, +process.env.MAX_JOBS || 3); // parallel downloads
const DL = path.join(__dirname, 'downloads'), CACHE = path.join(__dirname, 'cache.json');
fs.mkdirSync(DL, { recursive: true });

/* ---------- path safety ---------- */
// Download folders must live under these bases (default: home dir + ./downloads).
const BASES = [DL, os.homedir(), ...(process.env.ALLOW_DIRS || '').split(path.delimiter).filter(Boolean)].map(p => path.resolve(p));
const within = (base, p) => { const x = path.relative(base, p); return x === '' || (!x.startsWith('..') && !path.isAbsolute(x)); };
const allowedDir = p => BASES.some(b => within(b, p)) && path.dirname(p) !== p; // never a filesystem root
const real = p => { try { return fs.realpathSync(p); } catch { return p; } }; // resolves symlinks when the path exists

/* ---------- cache (JSON file, debounced atomic writes) ---------- */
let db = { roots: [], rows: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(CACHE, 'utf8')) }; } catch {}
const roots = new Set([DL, ...db.roots.map(r => path.resolve(r)).filter(allowedDir)]);
let saveTimer;
function flushDb() {
  clearTimeout(saveTimer);
  try { fs.writeFileSync(CACHE + '.tmp', JSON.stringify({ roots: [...roots], rows: db.rows })); fs.renameSync(CACHE + '.tmp', CACHE); }
  catch (e) { console.error('cache write failed:', e.message); }
}
const saveDb = () => { clearTimeout(saveTimer); saveTimer = setTimeout(flushDb, 300); };

/* ---------- helpers ---------- */
const inRoots = p => { const r = real(p); return [...roots].some(b => within(real(b), r) && r !== real(b)); };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
function localPath(u) { // stored file URL -> safe absolute path (only inside download folders)
  try {
    const x = new URL(u), q = x.searchParams.get('path');
    const a = q ? path.resolve(q) : x.pathname.startsWith('/downloads/') ? path.resolve(DL, decodeURIComponent(x.pathname.slice(11))) : null;
    return a && inRoots(a) ? a : null;
  } catch { return null; }
}
function normDir(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return DL;
  let c = raw.trim().replace(/"/g, '');
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(c)) return DL; // Windows path on a non-Windows host
  if (c === '~' || c.startsWith('~/') || c.startsWith('~\\')) c = path.join(os.homedir(), c.slice(1));
  const a = path.resolve(c);
  if (!allowedDir(a)) throw new Error('That folder isn\u2019t allowed. Pick a folder inside your home directory.');
  fs.mkdirSync(a, { recursive: true });
  if (!roots.has(a)) { roots.add(a); saveDb(); }
  return a;
}
const isUrl = u => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };
const MISSING = 'yt-dlp isn\u2019t installed. Install yt-dlp and ffmpeg, then restart the server.';
const esc = s => s.replace(/%/g, '%%'); // literal % in a folder name must not act as a yt-dlp template field
const fmtSpeed = v => (Number.isFinite(+v) && +v > 0 ? (+v / 1048576).toFixed(2) + ' MiB/s' : '');
const fmtEta = v => { const n = +v; if (!Number.isFinite(n)) return '?'; return n >= 60 ? `${Math.floor(n / 60)}m ${Math.round(n % 60)}s` : `${Math.round(n)}s`; };

// Tiny job queue so a burst of requests can't spawn unlimited yt-dlp/ffmpeg processes.
let active = 0; const waiting = [];
const acquire = () => active < MAX_JOBS ? (active++, Promise.resolve()) : new Promise(r => waiting.push(r));
const release = () => { const n = waiting.shift(); n ? n() : active--; };

/* ---------- HTTP API ---------- */
const app = express();
const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(HOST);
app.use((req, res, next) => { // block DNS-rebinding: local-only servers only answer to local host names
  if (loopback && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '')) return res.sendStatus(403);
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Private-Network': 'true' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/downloads', express.static(DL));
app.get('/', (q, r) => r.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/health', (q, r) => r.json({ status: 'ok', msg: 'Backend is running', tools }));

app.get('/api/file', (req, res) => {
  const p = path.resolve(String(req.query.path || ''));
  if (!inRoots(p) || !isFile(p)) return res.status(404).json({ detail: 'File not found' });
  req.query.download ? res.download(p) : res.sendFile(p); // sendFile handles Range requests, so seeking works
});
app.post('/api/file_exists', (q, r) => {
  const p = localPath(q.body.filepath);
  r.json({ status: 'ok', exists: !!p && isFile(p) });
});
app.post('/api/delete_file', (q, r) => {
  const p = localPath(q.body.filepath);
  if (p && isFile(p)) {
    fs.unlinkSync(p);
    for (let d = path.dirname(p); !roots.has(d) && inRoots(d); d = path.dirname(d)) { // prune empty parents up to the root
      try { if (fs.readdirSync(d).length) break; fs.rmdirSync(d); } catch { break; }
    }
    for (const k in db.rows) if (localPath(db.rows[k].url) === p) delete db.rows[k];
    saveDb();
  }
  r.json({ status: 'ok' });
});
app.post('/api/open_location', (q, r) => {
  const p = localPath(q.body.filepath);
  if (p && fs.existsSync(p)) {
    const [cmd, args] = process.platform === 'win32' ? ['explorer', ['/select,' + p]]
      : process.platform === 'darwin' ? ['open', ['-R', p]] : ['xdg-open', [path.dirname(p)]];
    const c = spawn(cmd, args, { stdio: 'ignore', detached: true }); c.on('error', () => {}); c.unref();
  }
  r.json({ status: 'ok' });
});
app.post('/api/browse_directory', (q, r) => r.json({ status: 'error', msg: 'No folder picker here. Type the folder path instead.' }));
app.post('/api/clear_cache', (q, r) => { db.rows = {}; saveDb(); r.json({ status: 'ok' }); });

app.post('/api/playlist_info', (req, res) => {
  if (!isUrl(req.body.url)) return res.status(400).json({ detail: 'That doesn\u2019t look like a link' });
  execFile(YTDLP, ['--flat-playlist', '-J', '--ignore-errors', '--', req.body.url], { maxBuffer: 1 << 28, timeout: 60000 }, (err, out) => {
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
    res.json({ status: 'ok', playlist: { title: info.title || 'Untitled Playlist', uploader: info.uploader || '', entryCount: entries.length, entries } });
  });
});
app.use((err, q, res, n) => res.status(err.status || 500).json({ detail: err.type === 'entity.parse.failed' ? 'Bad JSON' : 'Server error' }));

/* ---------- yt-dlp argument builder ---------- */
function buildArgs({ url, type, ext, q, s, dir, recode }) {
  const a = ['--quiet', '--no-simulate', '--progress', '--newline', '--no-playlist', '--no-warnings',
    '-N', String(CONNS), '--http-chunk-size', '10M', '--buffer-size', '256K', '--no-mtime', '--retries', '5', '--fragment-retries', '5',
    '--progress-template', 'download:PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '--print', 'after_move:DONE\t%(filepath)s\t%(title)s\t%(thumbnail)s\t%(duration_string)s'];
  if (USE_ARIA2 && tools.aria2c) // multi-connection downloader for plain HTTP streams; fragmented HLS/DASH stays native
    a.push('--downloader', 'aria2c', '--downloader', 'dash,m3u8:native', '--downloader-args', `aria2c:-x ${CONNS} -s ${CONNS} -k 1M --min-split-size=1M --file-allocation=none`);
  if (type === 'audio_only') {
    a.push('-f', 'bestaudio/best', '-x', '--audio-format', ext === 'ogg' ? 'vorbis' : ext); // yt-dlp calls .ogg audio "vorbis"
    if (!['wav', 'flac'].includes(ext)) a.push('--audio-quality', q);
  } else {
    const f = type === 'video_only' ? `bestvideo[ext=${ext}]/bestvideo/best`
      : ext === 'webm' ? 'bestvideo[ext=webm]+bestaudio[ext=webm]/bestvideo[ext=webm]+bestaudio/best[ext=webm]/best'
      : `bestvideo[ext=${ext}]+bestaudio[ext=m4a]/bestvideo[ext=${ext}]+bestaudio/best[ext=${ext}]/best`;
    // Remux (fast, lossless copy) first; only re-encode as a fallback when remuxing fails.
    a.push('-f', f, '--merge-output-format', ext, recode ? '--recode-video' : '--remux-video', ext);
  }
  // Audio files are small, so tagging them is cheap. Videos skip the extra full-file ffmpeg passes unless EMBED_VIDEO=1.
  if (type === 'audio_only' || EMBED_VIDEO) a.push('--embed-metadata');
  if (type === 'audio_only' ? ['mp3', 'm4a', 'ogg', 'flac'].includes(ext) : EMBED_VIDEO && ['mp4', 'mkv', 'mov', 'm4v'].includes(ext)) a.push('--write-thumbnail', '--embed-thumbnail');
  if (s.extractSubtitles) a.push('--write-subs', '--write-auto-subs', '--sub-langs', 'en');
  if (s.downloadMetadata) a.push('--write-description', '--write-info-json');
  let o = esc(dir.replace(/\\/g, '/')) + '/';
  if (s.organizeTypes !== false) o += type === 'audio_only' ? 'Audio/' : 'Video/';
  if (s.organizeChannel) o += '%(uploader)s/';
  a.push('-o', o + '%(title).150B.%(ext)s', '--', url); // .150B keeps very long titles under filesystem name limits
  return a;
}

/* ---------- WebSocket download ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/download', maxPayload: 64 * 1024 });
const children = new Set();

wss.on('connection', (ws, req) => {
  if (ORIGIN !== '*' && req.headers.origin && req.headers.origin !== ORIGIN) return ws.close();
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  let child, closed = false, slot = false;
  ws.on('close', () => { closed = true; child && child.kill(); });
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
      let file, err = '', buf = '', lastGot = 0, stage = 0;
      child = spawn(YTDLP, args); children.add(child);
      child.on('error', e => reject(new Error(e.code === 'ENOENT' ? MISSING : e.message)));
      child.stderr.on('data', d => { err = (err + d).slice(-4000); });
      child.stdout.on('data', d => {
        const lines = (buf + d).split('\n'); buf = lines.pop();
        for (const l of lines) {
          if (l.startsWith('PROG|')) {
            const [, got, t1, t2, sp, eta] = l.split('|'), tot = +t1 || +t2;
            if (+got < lastGot) stage++; // a new stream (e.g. audio after video) started
            lastGot = +got;
            send({ status: 'downloading', percent: tot ? Math.min(99, got / tot * 100) : 0, stage,
              msg: `Downloading ${fmtSpeed(sp) || '...'}, ETA ${fmtEta(eta)}` });
          } else if (l.startsWith('DONE\t')) { const [, fp, title, thumb, dur] = l.split('\t'); file = { fp, title, thumb, dur }; }
        }
      });
      child.on('close', code => {
        children.delete(child);
        if (code === 0 && file) return resolve(file);
        const lines = err.trim().split('\n').filter(l => l.trim());
        reject(Object.assign(new Error((lines.reverse().find(l => /^ERROR/.test(l)) || lines[0] || `yt-dlp exited with code ${code}`).replace(/^ERROR:\s*/, '')), { full: err }));
      });
    });
  }

  async function download(req) {
    const { url, type = 'video_audio', settings: s = {} } = req;
    if (!isUrl(url)) throw new Error('That doesn\u2019t look like a link.');
    if (!['video_audio', 'video_only', 'audio_only'].includes(type)) throw new Error('Bad download type.');
    const ext = String(req.ext || (type === 'audio_only' ? 'mp3' : 'mp4')).toLowerCase(), q = String(req.quality || '192');
    if (!/^[a-z0-9]{2,5}$/.test(ext) || !/^(\d+|best)$/.test(q)) throw new Error('Bad format options.');
    const dir = normDir(s.downloadDirectory);
    const k = [url, type, q, ext, dir, !!s.extractSubtitles, !!s.downloadMetadata].join('|'); // settings that change the output are part of the key

    if (s.useCache !== false && db.rows[k]) {
      const p = localPath(db.rows[k].url);
      if (p && isFile(p)) {
        send({ status: 'progress', msg: 'Found in cache', percent: 100 });
        send({ status: 'completed', msg: 'Served from cache', file: db.rows[k] });
        return ws.close();
      }
      delete db.rows[k]; saveDb(); // stale entry
    }

    if (active >= MAX_JOBS) send({ status: 'starting', msg: `Queued (${waiting.length + 1} waiting)` });
    await acquire(); slot = true;
    if (closed) return; // client left while queued

    send({ status: 'starting', msg: 'Starting download' });
    const base = { url, type, ext, q, s, dir };
    let r;
    try { r = await run(buildArgs({ ...base, recode: false })); }
    catch (e) {
      const canRetry = !closed && type !== 'audio_only' && /remux|postprocess|ffmpeg|conversion|container/i.test(e.full || e.message);
      if (!canRetry) throw e;
      send({ status: 'starting', msg: 'Remux failed, converting instead (slower)' });
      r = await run(buildArgs({ ...base, recode: true }));
    }

    const na = v => (!v || v === 'NA' ? '' : v);
    const file = { title: r.title, thumbnail: na(r.thumb), duration: na(r.dur), type,
      url: `http://localhost:${PORT}/api/file?path=${encodeURIComponent(path.resolve(r.fp))}` };
    if (s.useCache !== false) { db.rows[k] = file; saveDb(); }
    send({ status: 'completed', msg: 'All done', file });
    ws.close();
  }
});

/* ---------- startup / shutdown ---------- */
const tools = { ytdlp: false, ffmpeg: false, aria2c: false };
const probe = (cmd, args, key) => execFile(cmd, args, { timeout: 5000 }, e => { tools[key] = !e; });
probe(YTDLP, ['--version'], 'ytdlp'); probe('ffmpeg', ['-version'], 'ffmpeg'); probe('aria2c', ['--version'], 'aria2c');
setTimeout(() => {
  if (!tools.ytdlp) console.warn('! yt-dlp not found on PATH (set YTDLP=/path/to/yt-dlp)');
  if (!tools.ffmpeg) console.warn('! ffmpeg not found on PATH: merging and audio conversion will fail');
}, 1500).unref();

const shutdown = () => { flushDb(); children.forEach(c => c.kill()); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (set PORT=...)` : e.message); process.exit(1); });
server.listen(PORT, HOST, () => console.log(`Downloader running at http://${HOST}:${PORT}`));