const express = require('express');
const { sql } = require('./db');
const { requireAdmin, sqlDate } = require('./auth');

const router = express.Router();
router.use(requireAdmin);

// Open reports, newest first
router.get('/reports', async (req, res, next) => {
  try {
    const rows = await sql`
      SELECT r.id, r.reason, r.created_at, r.game_id,
             ru.username AS reporter,
             g.title AS game_title, gu.username AS game_author,
             (SELECT COUNT(*) FROM reports x WHERE x.game_id = r.game_id AND x.status = 'open') AS open_count
      FROM reports r
      JOIN users ru ON ru.id = r.reporter_id
      LEFT JOIN games g ON g.id = r.game_id
      LEFT JOIN users gu ON gu.id = g.user_id
      WHERE r.status = 'open'
      ORDER BY r.created_at DESC, r.id DESC`;
    for (const r of rows) r.created_at = sqlDate(r.created_at);
    res.json({ reports: rows });
  } catch (err) { next(err); }
});

// Resolve a report without action
router.delete('/reports/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const r = await sql`SELECT id, game_id FROM reports WHERE id = ${id} AND status = 'open'`;
    if (!r.length) return res.status(404).json({ error: 'Report not found.' });
    const row = r[0];
    await sql`UPDATE reports SET status = 'resolved' WHERE id = ${row.id}`;
    if (row.game_id) {
      await sql`UPDATE reports SET status = 'resolved' WHERE game_id = ${row.game_id} AND status = 'open'`;
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
