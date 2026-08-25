const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { sql, sqlOne, insertReturning, tx, query } = require('./db');
const { requireAuth, sqlDate } = require('./auth');
const { getStore } = require('@netlify/blobs');

const router = express.Router();

const MAX_GAME_BYTES = 60 * 1024 * 1024; // 60 MB
const MAX_SHOT_BYTES = 5 * 1024 * 1024;  // 5 MB
const SHOT_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// Blob stores (site-level so uploads persist across deploys)
const assetStore = () => getStore('game-assets');
const shotStore = () => getStore('screenshots');

// multer still writes to a tmp dir on the Lambda filesystem; we then read those
// buffers and push them into Blobs.
const upload = multer({
  storage: multer.diskStorage({
    destination: '/tmp/multer-uploads',
    filename: (req, file, cb) => {
      fs.mkdirSync('/tmp/multer-uploads', { recursive: true });
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname).toLowerCase()}`);
    }
  }),
  limits: { fileSize: MAX_GAME_BYTES, files: 2 }
});

// ---------- helpers ----------

function parseTags(raw) {
  const seen = new Set();
  for (const part of String(raw || '').split(/[,\s]+/)) {
    let t = part.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!t) continue;
    t = t.slice(0, 24);
    seen.add(t);
    if (seen.size >= 8) break;
  }
  return [...seen];
}

// Blob key helpers: keep them flat and path-safe.
const gameAssetKey = (gameId, rel) => `games/${gameId}/${rel.split('\\').join('/')}`;
const sourceKey = (gameId) => `games/${gameId}/source.zip`;

/** Extract a zip from a local file, uploading each entry to Netlify Blobs.
 *  Returns { baseDir } where index.html lives at games/<id>/<baseDir>index.html.
 *  Defends against zip-slip by validating entry paths are under the conceptual
 *  root. */
async function extractGameZipToBlobs(zipPath, gameId) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const names = entries.filter(e => !e.isDirectory).map(e => e.entryName.replace(/\\/g, '/'));

  let baseDir = '';
  if (!names.includes('index.html')) {
    const candidates = new Set();
    for (const n of names) {
      const m = n.match(/^([^/]+\/)index\.html$/);
      if (m) candidates.add(m[1]);
    }
    if (candidates.size === 1) baseDir = [...candidates][0];
    else throw new Error('The zip must contain an index.html at its root (or inside a single top-level folder).');
  }

  const store = assetStore();
  for (const entry of entries) {
    const rel = entry.entryName.replace(/\\/g, '/');
    // zip-slip guard: reject absolute or `..` traversal
    if (path.isAbsolute(rel) || rel.split('/').some(seg => seg === '..')) {
      throw new Error('Illegal file path inside zip.');
    }
    if (entry.isDirectory) continue;
    await store.set(gameAssetKey(gameId, rel), entry.getData(), {
      metadata: { contentType: mimeFor(rel) },
    });
  }
  return { baseDir };
}

function mimeFor(p) {
  const ext = path.extname(p).toLowerCase();
  const map = {
    '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript',
    '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4',
    '.webm': 'video/webm', '.txt': 'text/plain', '.xml': 'application/xml',
  };
  return map[ext] || 'application/octet-stream';
}

async function gameRow(id, viewerId) {
  // Mirror the original aggregate query; viewer-scoped liked/my_rating columns
  // are added conditionally to keep the shape identical to the SQLite version.
  const { sql } = require('./db');
  let rows;
  if (viewerId) {
    rows = await sql`
      SELECT g.*, u.username AS author,
        (SELECT COUNT(*) FROM likes l WHERE l.game_id = g.id) AS like_count,
        (SELECT COUNT(*) FROM comments c WHERE c.game_id = g.id) AS comment_count,
        (SELECT ROUND(AVG(stars), 2) FROM ratings r WHERE r.game_id = g.id) AS avg_rating,
        (SELECT COUNT(*) FROM ratings r WHERE r.game_id = g.id) AS rating_count,
        (SELECT COUNT(*) FROM likes l WHERE l.game_id = g.id AND l.user_id = ${viewerId}) AS liked,
        (SELECT stars FROM ratings r WHERE r.game_id = g.id AND r.user_id = ${viewerId}) AS my_rating
      FROM games g JOIN users u ON u.id = g.user_id WHERE g.id = ${id}`;
  } else {
    rows = await sql`
      SELECT g.*, u.username AS author,
        (SELECT COUNT(*) FROM likes l WHERE l.game_id = g.id) AS like_count,
        (SELECT COUNT(*) FROM comments c WHERE c.game_id = g.id) AS comment_count,
        (SELECT ROUND(AVG(stars), 2) FROM ratings r WHERE r.game_id = g.id) AS avg_rating,
        (SELECT COUNT(*) FROM ratings r WHERE r.game_id = g.id) AS rating_count,
        0 AS liked,
        NULL AS my_rating
      FROM games g JOIN users u ON u.id = g.user_id WHERE g.id = ${id}`;
  }
  return rows[0];
}

function shapeGame(g) {
  if (!g) return null;
  // tags are fetched separately (see callers)
  return {
    id: g.id,
    title: g.title,
    description: g.description,
    type: g.type,
    has_source: !!g.has_source,
    author: g.author,
    author_id: g.user_id,
    screenshot: g.screenshot_path ? `/uploads/screenshot/${g.screenshot_path}` : null,
    views: g.views,
    downloads: g.downloads,
    likes: g.like_count,
    liked: !!g.liked,
    comments: g.comment_count,
    rating: g.avg_rating || 0,
    rating_count: g.rating_count,
    my_rating: g.my_rating || 0,
    tags: g.tags || [],
    created_at: sqlDate(g.created_at),
  };
}

async function loadTags(gameId) {
  const rows = await sql`SELECT tag FROM tags WHERE game_id = ${gameId} ORDER BY tag`;
  return rows.map(r => r.tag);
}

// ---------- routes ----------

const uploadFields = [
  { name: 'file', maxCount: 1 },
  { name: 'screenshot', maxCount: 1 }
];
router.post('/', requireAuth, (req, res, next) => {
  upload.fields(uploadFields)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    createGame(req, res).catch(next);
  });
});

async function createGame(req, res) {
  const title = String(req.body.title || '').trim().slice(0, 100);
  const description = String(req.body.description || '').trim().slice(0, 5000);
  let type = req.body.type === 'download' ? 'download' : 'web';
  const tags = parseTags(req.body.tags);
  const gameFile = req.files?.file?.[0];
  const shotFile = req.files?.screenshot?.[0];

  if (!title) { cleanupTmp([gameFile, shotFile]); return res.status(400).json({ error: 'Title is required.' }); }
  if (!gameFile) { cleanupTmp([gameFile, shotFile]); return res.status(400).json({ error: 'Please attach a game file (.zip or .html).' }); }
  if (shotFile && !SHOT_MIMES.has(shotFile.mimetype)) {
    cleanupTmp([gameFile, shotFile]);
    return res.status(400).json({ error: 'Screenshot must be a PNG, JPG, WEBP or GIF image.' });
  }

  const ext = path.extname(gameFile.originalname).toLowerCase();
  if (!['.zip', '.html', '.htm'].includes(ext)) {
    cleanupTmp([gameFile, shotFile]);
    return res.status(400).json({ error: 'Game must be a .zip or single .html file.' });
  }
  if (ext !== '.zip') type = 'web'; // single html files are always playable

  let gameId;
  try {
    gameId = await tx(async (q) => {
      const inserted = await q.query(
        'INSERT INTO games (user_id, title, description, type) VALUES ($1, $2, $3, $4) RETURNING id',
        [req.session.userId, title, description, type]
      );
      const gid = inserted[0].id;
      let entryPath = '';
      let hasSource = 0;

      if (ext === '.zip') {
        const buf = fs.readFileSync(gameFile.path);
        await assetStore().set(sourceKey(gid), buf, {
          metadata: { contentType: 'application/zip' },
        });
        hasSource = 1;
        if (type === 'web') {
          ({ baseDir: entryPath } = await extractGameZipToBlobs(gameFile.path, gid));
        }
      } else {
        const buf = fs.readFileSync(gameFile.path);
        await assetStore().set(gameAssetKey(gid, 'index.html'), buf, {
          metadata: { contentType: 'text/html' },
        });
      }

      let shotName = null;
      if (shotFile) {
        shotName = path.basename(shotFile.filename);
        const shotBuf = fs.readFileSync(shotFile.path);
        await shotStore().set(shotName, shotBuf, {
          metadata: { contentType: shotFile.mimetype },
        });
      }
      await q.query(
        'UPDATE games SET entry_path = $1, has_source = $2, screenshot_path = $3 WHERE id = $4',
        [entryPath, hasSource, shotName, gid]
      );

      for (const t of tags) {
        await q.query('INSERT INTO tags (game_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING', [gid, t]);
      }
      return gid;
    });
  } catch (err) {
    cleanupTmp([gameFile, shotFile]);
    throw err;
  }

  cleanupTmp([gameFile, shotFile]);
  const g = await gameRow(gameId, req.session.userId);
  g.tags = await loadTags(gameId);
  res.json({ game: shapeGame(g) });
}

function cleanupTmp(files) {
  for (const f of files || []) {
    if (f && f.path && fs.existsSync(f.path)) { try { fs.unlinkSync(f.path); } catch { /* */ } }
  }
}

// List / search
router.get('/', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const tag = String(req.query.tag || '').trim().toLowerCase();
    const sort = ['new', 'views', 'rating', 'likes'].includes(req.query.sort) ? req.query.sort : 'new';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = 24;

    const where = [];
    const params = [];
    let pi = 1;
    if (q) {
      where.push(`(g.title ILIKE $${pi} OR g.description ILIKE $${pi + 1})`);
      params.push(`%${q}%`, `%${q}%`); pi += 2;
    }
    if (tag) {
      where.push(`g.id IN (SELECT game_id FROM tags WHERE tag = $${pi})`);
      params.push(tag); pi += 1;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = {
      new: 'g.created_at DESC, g.id DESC',
      views: 'g.views DESC, g.id DESC',
      likes: 'like_count DESC, g.id DESC',
      rating: 'avg_rating DESC, rating_count DESC, g.id DESC'
    }[sort];

    const viewerId = req.session.userId || null;
    const baseSelect = `
      SELECT g.*, u.username AS author,
        (SELECT COUNT(*) FROM likes l WHERE l.game_id = g.id) AS like_count,
        (SELECT COUNT(*) FROM comments c WHERE c.game_id = g.id) AS comment_count,
        (SELECT ROUND(AVG(stars), 2) FROM ratings r WHERE r.game_id = g.id) AS avg_rating,
        (SELECT COUNT(*) FROM ratings r WHERE r.game_id = g.id) AS rating_count
      FROM games g JOIN users u ON u.id = g.user_id`;

    // total count
    const countSql = `SELECT COUNT(*)::int AS n FROM games g ${whereSql}`;
    const totalRows = await query(countSql, params);
    const total = totalRows.length ? totalRows[0].n : 0;

    const listSql = `${baseSelect} ${whereSql} ORDER BY ${orderSql} LIMIT $${pi} OFFSET $${pi + 1}`;
    const rows = await query(listSql, [...params, perPage, (page - 1) * perPage]);

    // attach tags per game
    for (const g of rows) {
      g.tags = await loadTags(g.id);
    }
    res.json({
      total,
      page,
      pages: Math.max(1, Math.ceil(total / perPage)),
      games: rows.map(shapeGame)
    });
  } catch (err) { next(err); }
});

// Popular tags for filter chips
router.get('/tags/popular', async (req, res, next) => {
  try {
    const rows = await sql`
      SELECT tag, COUNT(*) AS n FROM tags
      GROUP BY tag ORDER BY n DESC, tag ASC LIMIT 20`;
    res.json({ tags: rows });
  } catch (err) { next(err); }
});

// Single game
router.get('/:id', async (req, res, next) => {
  try {
    const viewerId = req.session.userId || null;
    const g = await gameRow(Number(req.params.id), viewerId);
    if (!g) return res.status(404).json({ error: 'Game not found.' });
    g.tags = await loadTags(g.id);
    res.json({ game: shapeGame(g) });
  } catch (err) { next(err); }
});

// Play URL + count a view
router.post('/:id/view', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const g = await sqlOne`SELECT id, type, entry_path FROM games WHERE id = ${id}`;
    if (!g) return res.status(404).json({ error: 'Game not found.' });
    await sql`UPDATE games SET views = views + 1 WHERE id = ${id}`;
    res.json({ play_url: `/uploads/game/${id}/${g.entry_path}index.html` });
  } catch (err) { next(err); }
});

// Source zip download link + count
router.post('/:id/download', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const g = await sqlOne`SELECT id, has_source FROM games WHERE id = ${id}`;
    if (!g) return res.status(404).json({ error: 'Game not found.' });
    if (!g.has_source) return res.status(400).json({ error: 'No downloadable source for this game.' });
    await sql`UPDATE games SET downloads = downloads + 1 WHERE id = ${id}`;
    res.json({ url: `/uploads/source/${id}` });
  } catch (err) { next(err); }
});

// Toggle like
router.post('/:id/like', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const g = await sqlOne`SELECT id FROM games WHERE id = ${id}`;
    if (!g) return res.status(404).json({ error: 'Game not found.' });
    const existing = await sqlOne`SELECT 1 FROM likes WHERE user_id = ${req.session.userId} AND game_id = ${id}`;
    if (existing) {
      await sql`DELETE FROM likes WHERE user_id = ${req.session.userId} AND game_id = ${id}`;
    } else {
      await sql`INSERT INTO likes (user_id, game_id) VALUES (${req.session.userId}, ${id})`;
    }
    const countRow = await sqlOne`SELECT COUNT(*)::int AS n FROM likes WHERE game_id = ${id}`;
    res.json({ liked: !existing, likes: countRow.n });
  } catch (err) { next(err); }
});

// Rate 1-5
router.put('/:id/rate', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const stars = Math.round(Number(req.body.stars));
    const g = await sqlOne`SELECT id FROM games WHERE id = ${id}`;
    if (!g) return res.status(404).json({ error: 'Game not found.' });
    if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'Stars must be 1-5.' });
    await sql`
      INSERT INTO ratings (user_id, game_id, stars) VALUES (${req.session.userId}, ${id}, ${stars})
      ON CONFLICT (user_id, game_id) DO UPDATE SET stars = EXCLUDED.stars`;
    const agg = await sqlOne`SELECT ROUND(AVG(stars),2) AS avg, COUNT(*)::int AS n FROM ratings WHERE game_id = ${id}`;
    res.json({ rating: agg.avg || 0, rating_count: agg.n, my_rating: stars });
  } catch (err) { next(err); }
});

// Comments
router.get('/:id/comments', async (req, res, next) => {
  try {
    const rows = await sql`
      SELECT c.id, c.body, c.created_at, c.user_id, u.username
      FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.game_id = ${Number(req.params.id)} ORDER BY c.created_at DESC, c.id DESC`;
    for (const c of rows) c.created_at = sqlDate(c.created_at);
    res.json({ comments: rows });
  } catch (err) { next(err); }
});

router.post('/:id/comments', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = String(req.body.body || '').trim().slice(0, 2000);
    if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
    const g = await sqlOne`SELECT id FROM games WHERE id = ${id}`;
    if (!g) return res.status(404).json({ error: 'Game not found.' });
    const inserted = await insertReturning`
      INSERT INTO comments (user_id, game_id, body) VALUES (${req.session.userId}, ${id}, ${body}) RETURNING id`;
    const c = await sqlOne`
      SELECT c.id, c.body, c.created_at, c.user_id, u.username
      FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ${inserted.id}`;
    if (c) c.created_at = sqlDate(c.created_at);
    res.json({ comment: c });
  } catch (err) { next(err); }
});

router.delete('/:id/comments/:commentId', requireAuth, async (req, res, next) => {
  try {
    const c = await sqlOne`SELECT * FROM comments WHERE id = ${Number(req.params.commentId)} AND game_id = ${Number(req.params.id)}`;
    if (!c) return res.status(404).json({ error: 'Comment not found.' });
    if (c.user_id !== req.session.userId && !req.user.admin) {
      return res.status(403).json({ error: 'Not your comment.' });
    }
    await sql`DELETE FROM comments WHERE id = ${c.id}`;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Report a game (auth required)
router.post('/:id/report', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const g = await sqlOne`SELECT id FROM games WHERE id = ${id}`;
    if (!g) return res.status(404).json({ error: 'Game not found.' });
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    const dup = await sqlOne`SELECT id FROM reports WHERE reporter_id = ${req.session.userId} AND game_id = ${id} AND status = 'open'`;
    if (dup) return res.status(409).json({ error: 'You already reported this game.' });
    await sql`INSERT INTO reports (reporter_id, game_id, reason) VALUES (${req.session.userId}, ${id}, ${reason})`;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Delete own game (admins may delete any)
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const g = await sqlOne`SELECT * FROM games WHERE id = ${id}`;
    if (!g) return res.status(404).json({ error: 'Game not found.' });
    if (g.user_id !== req.session.userId && !req.user.admin) {
      return res.status(403).json({ error: 'Not your game.' });
    }
    await sql`DELETE FROM games WHERE id = ${id}`; // cascades
    // best-effort blob cleanup
    try {
      const store = assetStore();
      const { blobs } = await store.list({ prefix: `games/${id}/` });
      for (const b of blobs) await store.delete(b.key);
      if (g.screenshot_path) await shotStore().delete(g.screenshot_path);
    } catch { /* cleanup is best-effort */ }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.extractGameZipToBlobs = extractGameZipToBlobs;
module.exports.gameAssetKey = gameAssetKey;
module.exports.sourceKey = sourceKey;
module.exports.assetStore = assetStore;
module.exports.shotStore = shotStore;
module.exports.loadTags = loadTags;
module.exports.gameRow = gameRow;
module.exports.shapeGame = shapeGame;
