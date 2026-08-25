const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require(path.join(__dirname, '..', 'node_modules', 'bcryptjs'));

process.chdir(path.join(__dirname, '..'));
const db = require(path.join(__dirname, '..', 'src', 'db'));

const GAMES_DIR = path.join(__dirname, '..', 'uploads', 'games');
fs.mkdirSync(GAMES_DIR, { recursive: true });

const BOT_USER = process.env.SEED_USER || 'vibe_bot';
let bot = db.prepare('SELECT * FROM users WHERE username = ?').get(BOT_USER);
if (!bot) {
  const pw = 'bot-' + crypto.randomBytes(4).toString('hex');
  const info = db.prepare('INSERT INTO users (username, password_hash, admin) VALUES (?, ?, 0)')
    .run(BOT_USER, bcrypt.hashSync(pw, 10));
  bot = { id: info.lastInsertRowid };
  console.log(`created uploader account "${BOT_USER}" (password: ${pw})`);
} else if (bot.admin) {
  // the demo bot should never hog the auto-admin slot
  db.prepare('UPDATE users SET admin = 0 WHERE id = ?').run(bot.id);
}

const promoteArg = process.argv[2] || '';
if (promoteArg.startsWith('admin:')) {
  const name = promoteArg.slice(6).trim();
  if (!name) { console.error('usage: npm run seed -- admin:<username>'); process.exit(1); }
  let u = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
  if (u) {
    db.prepare('UPDATE users SET admin = 1 WHERE id = ?').run(u.id);
    console.log(`"${name}" is now an admin.`);
  } else {
    const pw = crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO users (username, password_hash, admin) VALUES (?, ?, 1)')
      .run(name, bcrypt.hashSync(pw, 10));
    console.log(`created admin "${name}" (password: ${pw})`);
  }
}

const CATALOG_HANDMADE = require('./seed-catalog-handmade.js');

const insertGame = db.prepare(
  'INSERT INTO games (user_id, title, description, type) VALUES (?, ?, ?, ?)'
);
const insertTag = db.prepare('INSERT OR IGNORE INTO tags (game_id, tag) VALUES (?, ?)');

const GEN_CATALOG = path.join(__dirname, '..', 'games-to-upload', 'gen-catalog.json');
const GENERATED = fs.existsSync(GEN_CATALOG)
  ? JSON.parse(fs.readFileSync(GEN_CATALOG, 'utf8'))
  : [];
const CATALOG = [...CATALOG_HANDMADE, ...GENERATED];

for (const g of CATALOG) {
  const srcPath = path.join(__dirname, '..', 'games-to-upload', g.file);
  if (!fs.existsSync(srcPath)) {
    console.error(`missing file: ${g.file}`);
    continue;
  }
  const existing = db.prepare('SELECT id FROM games WHERE title = ? AND user_id = ?').get(g.title, bot.id);
  if (existing) {
    // refresh the playable copy so source fixes reach published games
    fs.mkdirSync(path.join(GAMES_DIR, String(existing.id)), { recursive: true });
    fs.copyFileSync(srcPath, path.join(GAMES_DIR, String(existing.id), 'index.html'));
    console.log(`refreshed: ${g.title} (#${existing.id})`);
    continue;
  }
  const gameId = db.transaction(() => {
    const info = insertGame.run(bot.id, g.title, g.description, 'web');
    const dir = path.join(GAMES_DIR, String(info.lastInsertRowid));
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(srcPath, path.join(dir, 'index.html'));
    db.prepare('UPDATE games SET entry_path = ? WHERE id = ?').run('', info.lastInsertRowid);
    for (const t of g.tags.split(/\s+/).filter(Boolean)) insertTag.run(info.lastInsertRowid, t);
    return info.lastInsertRowid;
  })();
  console.log(`published #${gameId}: ${g.title}`);
}
console.log('done.');
