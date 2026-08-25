// Build-time script: bundles the demo game catalog + HTML contents into a
// single JSON file (netlify/functions/_seed-data.json) that the runtime seed
// Netlify Function reads to populate the database and Blobs. Run during the
// Netlify build via netlify.toml's [build] command.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games-to-upload');
const GEN_CATALOG = path.join(GAMES_DIR, 'gen-catalog.json');
const OUT = path.join(ROOT, 'src', 'seed-data.json');

const HANDMADE = require(path.join(ROOT, 'scripts', 'seed-catalog-handmade.js'));

const generated = fs.existsSync(GEN_CATALOG) ? JSON.parse(fs.readFileSync(GEN_CATALOG, 'utf8')) : [];
const catalog = [...HANDMADE, ...generated];

const out = [];
for (const g of catalog) {
  const file = path.join(GAMES_DIR, g.file);
  if (!fs.existsSync(file)) {
    console.error(`seed: missing file ${g.file}, skipping`);
    continue;
  }
  const html = fs.readFileSync(file, 'utf8');
  out.push({ title: g.title, description: g.description, tags: g.tags, file: g.file, html });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`seed bundle: ${out.length} games -> ${path.relative(ROOT, OUT)}`);
