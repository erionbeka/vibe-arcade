const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const connectPgSimple = require('connect-pg-simple');
const { getDatabase } = require('@netlify/database');

require('./src/db'); // initialize database helpers

const authRoutes = require('./src/auth');
const gameRoutes = require('./src/games');
const adminRoutes = require('./src/admin');
const seedRoutes = require('./src/seed');

function buildApp() {
  const app = express();

  // Behind a reverse proxy, so trust the first hop for real client IPs.
  // Netlify always fronts functions with a proxy, so default to trusting it.
  app.set('trust proxy', 1);

  // Session secret — persistent in serverless via env var. Fall back to a
  // generated one for local dev only (sessions reset on restart otherwise).
  const secret = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');

  // Basic security headers for our own pages
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  // Brute-force / spam protection
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
  const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
  const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false });

  app.use(express.json({ limit: '10mb' }));

  // Sessions: store in Postgres via the Netlify Database pool so logins
  // survive across serverless invocations.
  let sessionStore;
  try {
    const pgPool = getDatabase().pool;
    const PostgresStore = connectPgSimple(session);
    sessionStore = new PostgresStore({ pool: pgPool, tableName: 'session', createTableIfMissing: false });
  } catch (err) {
    // Fallback to MemoryStore in local dev when the DB pool isn't available
    sessionStore = undefined;
  }

  app.use(session({
    store: sessionStore,
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.SECURE_COOKIES === '1',
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    },
  }));

  app.use('/api', apiLimiter);
  app.use(express.static(path.join(__dirname, 'public')));

  app.use('/api/auth/register', authLimiter);
  app.use('/api/auth/login', authLimiter);
  app.use('/api/games', uploadLimiter);

  app.use('/api/auth', authRoutes);
  app.use('/api/games', gameRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/seed', seedRoutes);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (req.path.startsWith('/api')) {
      return res.status(500).json({ error: 'Something went wrong.' });
    }
    res.status(500).send('Server error');
  });

  return app;
}

const app = buildApp();
module.exports = { app, buildApp };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`Vibe Arcade running at http://localhost:${PORT}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
      process.exit(1);
    }
    throw err;
  });
}
