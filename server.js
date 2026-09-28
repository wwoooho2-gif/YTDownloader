'use strict';
// Node.js port of main.py. Needs yt-dlp and ffmpeg installed and on PATH.
const express = require('express'), http = require('http'), { WebSocketServer } = require('ws');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn, execFile } = require('child_process');

const HOST = process.env.HOST || '127.0.0.1', PORT = +process.env.PORT || 8000;
const ORIGIN = process.env.ALLOW_ORIGIN || '*'; // e.g. https://you.github.io
const YTDLP = process.env.YTDLP || 'yt-dlp';
const DL = path.join(__dirname, 'downloads'), CACHE = path.join(__dirname, 'cache.json');
fs.mkdirSync(DL, { recursive: true });

/* ---------- cache (JSON file, no native deps) ---------- */
let db = { roots: [], rows: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(CACHE, 'utf8')) }; } catch {}
const saveDb = () => fs.writeFileSync(CACHE, JSON.stringify(db));
const roots = new Set([DL, ...db.roots]);

/* ---------- helpers ---------- */
const inRoots = p => [...roots].some(r => { const x = path.relative(r, p); return x && !x.startsWith('..') && !path.isAbsolute(x); });
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
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(c)) return DL;
  if (c.startsWith('~')) c = path.join(os.homedir(), c.slice(1));
  const a = path.resolve(c); fs.mkdirSync(a, { recursive: true });
  if (!roots.has(a)) { roots.add(a); db.roots = [...roots]; saveDb(); }
  return a;
}
const OK = new Set(['%(title)s', '%(uploader)s', '%(upload_date)s', '%(resolution)s', '%(id)s', '%(ext)s']);
function tpl(raw) {
  const d = '%(uploader)s - %(title)s.%(ext)s';
  if (typeof raw !== 'string' || !raw.trim()) return d;
  let t = raw.trim().replace(/[\/\\]/g, '_');
  for (const k of t.match(/%\([^)]+\)s/g) || []) if (!OK.has(k)) t = t.split(k).join('');
  if (!t.includes('%(ext)s')) t += t.endsWith('.') ? '%(ext)s' : '.%(ext)s';
  return t.replace(/\s{2,}/g, ' ').trim() || d;
}
const isUrl = u => typeof u === 'string' && /^https?:\/\//i.test(u);
const MISSING = 'yt-dlp isn\u2019t installed. Install yt-dlp and ffmpeg, then restart the server.';

/* ---------- HTTP API ---------- */
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Private-Network': 'true' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/downloads', express.static(DL));
app.get('/', (q, r) => r.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/health', (q, r) => r.json({ status: 'ok', msg: 'Backend is running' }));

app.get('/api/file', (req, res) => {
  const p = path.resolve(String(req.query.path || ''));
  if (!inRoots(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return res.status(404).json({ detail: 'File not found' });
  req.query.download ? res.download(p) : res.sendFile(p);
});
app.post('/api/file_exists', (q, r) => {
  const p = localPath(q.body.filepath);
  r.json({ status: 'ok', exists: !!p && fs.existsSync(p) && fs.statSync(p).isFile() });
});
app.post('/api/delete_file', (q, r) => {
  const p = localPath(q.body.filepath);
  if (p && fs.existsSync(p)) {
    fs.unlinkSync(p);
    const d = path.dirname(p);
    if (d !== DL && !fs.readdirSync(d).length) fs.rmdirSync(d);
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
  execFile(YTDLP, ['--flat-playlist', '-J', '--ignore-errors', '--', req.body.url], { maxBuffer: 1 << 28 }, (err, out) => {
    if (err && err.code === 'ENOENT') return res.status(500).json({ detail: MISSING });
    let info; try { info = JSON.parse(out); } catch { return res.status(400).json({ detail: 'Could not extract playlist info' }); }
    const entries = (info.entries || []).filter(Boolean).map((e, i) => {
      const u = [e.webpage_url, e.url].find(isUrl) || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null);
      return { id: String(e.id || i + 1), index: i + 1, title: e.title || `Untitled #${i + 1}`, url: u, thumbnail: e.thumbnail || '',
        duration: e.duration_string || (e.duration != null ? e.duration + 's' : '?:??'), uploader: e.uploader || info.uploader || '', available: !!u };
    });
    if (!entries.length) return res.status(400).json({ detail: 'No downloadable playlist entries found' });
    res.json({ status: 'ok', playlist: { title: info.title || 'Untitled Playlist', uploader: info.uploader || '', entryCount: entries.length, entries } });
  });
});

/* ---------- WebSocket download ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/download' });

wss.on('connection', (ws, req) => {
  if (ORIGIN !== '*' && req.headers.origin && req.headers.origin !== ORIGIN) return ws.close();
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  let child; ws.on('close', () => child && child.kill());
  send({ status: 'connected', msg: 'Connected' });

  ws.once('message', async raw => {
    try { await download(JSON.parse(raw)); }
    catch (e) { send({ status: 'error', msg: e.message }); ws.close(); }
  });

  async function download(req) {
    const { url, type = 'video_audio', settings: s = {} } = req;
    if (!isUrl(url)) throw new Error('That doesn\u2019t look like a link.');
    const ext = String(req.ext || (type === 'audio_only' ? 'mp3' : 'mp4')), q = String(req.quality || '192');
    if (!/^[a-z0-9]{2,5}$/.test(ext) || !/^(\d+|best)$/.test(q)) throw new Error('Bad format options.');
    const dir = normDir(s.downloadDirectory), k = [url, type, q, ext].join('|');

    if (s.useCache !== false && db.rows[k]) {
      const p = localPath(db.rows[k].url);
      if (p && fs.existsSync(p)) {
        send({ status: 'progress', msg: 'Found in cache', percent: 100 });
        send({ status: 'completed', msg: 'Served from cache', file: db.rows[k] });
        return ws.close();
      }
      delete db.rows[k]; saveDb(); // stale entry
    }

    const a = ['--quiet', '--no-simulate', '--progress', '--newline', '--no-playlist', '--write-thumbnail', '--embed-metadata',
      '--progress-template', 'download:PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
      '--print', 'after_move:DONE\t%(filepath)s\t%(title)s\t%(thumbnail)s\t%(duration_string)s'];
    if (type === 'audio_only') {
      a.push('-f', 'bestaudio/best', '-x', '--audio-format', ext);
      if (!['wav', 'flac'].includes(ext)) a.push('--audio-quality', q);
    } else {
      const f = type === 'video_only' ? `bestvideo[ext=${ext}]/best`
        : ext === 'webm' ? 'bestvideo[ext=webm]+bestaudio[ext=webm]/bestvideo[ext=webm]+bestaudio/best[ext=webm]/best'
        : `bestvideo[ext=${ext}]+bestaudio[ext=m4a]/bestvideo[ext=${ext}]+bestaudio/best[ext=${ext}]/best`;
      a.push('-f', f, '--merge-output-format', ext, '--recode-video', ext);
    }
    if (type === 'audio_only' ? ['mp3', 'm4a', 'ogg', 'flac'].includes(ext) : ['mp4', 'mkv', 'mov', 'm4v'].includes(ext)) a.push('--embed-thumbnail');
    if (s.extractSubtitles) a.push('--write-subs', '--write-auto-subs', '--sub-langs', 'en');
    if (s.downloadMetadata) a.push('--write-description', '--write-info-json');

    let o = dir.replace(/\\/g, '/') + '/';
    if (s.organizeTypes !== false) o += type === 'audio_only' ? 'Audio/' : 'Video/';
    if (s.organizeChannel) o += '%(uploader)s/';
    a.push('-o', o + tpl(s.filenameTemplate), '--', url);

    send({ status: 'starting', msg: 'Starting download' });
    const r = await new Promise((resolve, reject) => {
      let file, err = '', buf = '';
      child = spawn(YTDLP, a);
      child.on('error', e => reject(new Error(e.code === 'ENOENT' ? MISSING : e.message)));
      child.stderr.on('data', d => err += d);
      child.stdout.on('data', d => {
        const lines = (buf + d).split('\n'); buf = lines.pop();
        for (const l of lines) {
          if (l.startsWith('PROG|')) {
            const [, got, t1, t2, sp, eta] = l.split('|'), tot = +t1 || +t2;
            send({ status: 'downloading', percent: tot ? Math.min(99, got / tot * 100) : 0,
              msg: `Downloading ${((+sp / 1048576) || 0).toFixed(2)} MiB/s, ETA ${eta === 'NA' ? '?' : eta + 's'}` });
          } else if (l.startsWith('DONE\t')) { const [, fp, title, thumb, dur] = l.split('\t'); file = { fp, title, thumb, dur }; }
        }
      });
      child.on('close', code => code === 0 && file ? resolve(file)
        : reject(new Error(err.trim().split('\n').pop() || `yt-dlp exited with code ${code}`)));
    });

    const na = v => (v === 'NA' ? '' : v);
    const file = { title: r.title, thumbnail: na(r.thumb), duration: na(r.dur), type,
      url: `http://localhost:${PORT}/api/file?path=${encodeURIComponent(path.resolve(r.fp))}` };
    if (s.useCache !== false) { db.rows[k] = file; saveDb(); }
    send({ status: 'completed', msg: 'All done', file });
    ws.close();
  }
});

server.listen(PORT, HOST, () => console.log(`Downloader running at http://${HOST}:${PORT}`));
