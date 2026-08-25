const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { sql, sqlOne, insertReturning } = require('./db');

const router = express.Router();

function publicUser(u) {
  return { id: u.id, username: u.username, admin: !!u.admin, created_at: u.created_at };
}

async function requireAuth(req, res, next) {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'You must be logged in.' });
    const user = await sqlOne`SELECT * FROM users WHERE id = ${req.session.userId}`;
    if (!user) return res.status(401).json({ error: 'You must be logged in.' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
router.requireAuth = requireAuth;

async function requireAdmin(req, res, next) {
  requireAuth(req, res, async (err) => {
    if (err) return next(err);
    if (!req.user.admin) return res.status(403).json({ error: 'Admins only.' });
    next();
  });
}
router.requireAdmin = requireAdmin;

// Postgres timestamps come back as Date objects when sent through the pg
// driver; serialise to the same "YYYY-MM-DD HH:MM:SS" shape the frontend expects.
function sqlDate(d) {
  if (!d) return null;
  if (typeof d === 'string') {
    // already a string; normalise T to space and trim tz
    return d.replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
  }
  const dd = d instanceof Date ? d : new Date(d);
  return dd.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}
router.sqlDate = sqlDate;

router.get('/me', async (req, res, next) => {
  try {
    if (!req.session.userId) return res.json({ user: null });
    const user = await sqlOne`SELECT * FROM users WHERE id = ${req.session.userId}`;
    if (user) user.created_at = sqlDate(user.created_at);
    res.json({ user: user ? publicUser(user) : null });
  } catch (err) { next(err); }
});

router.post('/register', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-24 characters (letters, numbers, underscore).' });
    }
    if (password.length < 6 || password.length > 200) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const exists = await sqlOne`SELECT id FROM users WHERE LOWER(username) = LOWER(${username})`;
    if (exists) return res.status(409).json({ error: 'That username is taken.' });
    const hash = bcrypt.hashSync(password, 10);
    const countRow = await sqlOne`SELECT COUNT(*)::int AS n FROM users`;
    const isFirstUser = countRow.n === 0;
    const inserted = await insertReturning`
      INSERT INTO users (username, password_hash, admin) VALUES (${username}, ${hash}, ${isFirstUser ? 1 : 0})
      RETURNING *`;
    req.session.userId = inserted.id;
    inserted.created_at = sqlDate(inserted.created_at);
    res.json({ user: publicUser(inserted) });
  } catch (err) { next(err); }
});

router.post('/login', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const user = await sqlOne`SELECT * FROM users WHERE LOWER(username) = LOWER(${username})`;
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    if (process.env.ADMIN_USERNAME && user.username.toLowerCase() === process.env.ADMIN_USERNAME.toLowerCase() && !user.admin) {
      await sql`UPDATE users SET admin = 1 WHERE id = ${user.id}`;
      user.admin = 1;
    }
    req.session.userId = user.id;
    user.created_at = sqlDate(user.created_at);
    res.json({ user: publicUser(user) });
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

module.exports = router;
