// Seed route: populates the demo games in the Netlify Database + Blobs.
// Idempotent. Mounted at /api/seed so it's served by the catch-all API
// function. The seed data is generated at build time by
// scripts/build-seed-bundle.js into src/seed-data.json.
const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const { sql, sqlOne, query } = require('./db');
const { getStore } = require('@netlify/blobs');

const router = express.Router();
const BOT_USERNAME = process.env.SEED_USER || 'vibe_bot';

let seedData = [];
try {
  const p = path.join(__dirname, 'seed-data.json');
  const fs = require('fs');
  if (fs.existsSync(p)) seedData = JSON.parse(fs.readFileSync(p, 'utf8'));
} catch { /* no seed data; seeding is a no-op */ }

router.post('/', async (req, res, next) => {
  try {
    if (!seedData.length) return res.json({ ok: true, created: 0, refreshed: 0, total_games: 0, note: 'no seed data bundled' });
    const assetStore = getStore('game-assets');

    let bot = await sqlOne`SELECT * FROM users WHERE LOWER(username) = LOWER(${BOT_USERNAME})`;
    if (!bot) {
      const pw = 'bot-' + Math.random().toString(36).slice(2, 10);
      const hash = bcrypt.hashSync(pw, 10);
      bot = await sqlOne`
        INSERT INTO users (username, password_hash, admin) VALUES (${BOT_USERNAME}, ${hash}, 0)
        RETURNING *`;
    } else if (bot.admin) {
      await sql`UPDATE users SET admin = 0 WHERE id = ${bot.id}`;
      bot.admin = 0;
    }

    let created = 0;
    let refreshed = 0;

    for (const g of seedData) {
      const existing = await sqlOne`SELECT id FROM games WHERE title = ${g.title} AND user_id = ${bot.id}`;
      const html = g.html || '';
      if (existing) {
        await assetStore.set(`games/${existing.id}/index.html`, html, {
          metadata: { contentType: 'text/html' },
        });
        refreshed++;
        continue;
      }
      const inserted = await sqlOne`
        INSERT INTO games (user_id, title, description, type) VALUES (${bot.id}, ${g.title}, ${g.description}, 'web')
        RETURNING id`;
      const gid = inserted.id;
      await assetStore.set(`games/${gid}/index.html`, html, {
        metadata: { contentType: 'text/html' },
      });
      for (const t of String(g.tags || '').split(/\s+/).filter(Boolean)) {
        await query('INSERT INTO tags (game_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING', [gid, t]);
      }
      created++;
    }

    const total = await sqlOne`SELECT COUNT(*)::int AS n FROM games`;
    res.json({ ok: true, bot: BOT_USERNAME, created, refreshed, total_games: total ? total.n : 0 });
  } catch (err) { next(err); }
});

module.exports = router;
