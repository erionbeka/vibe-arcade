// Serves uploaded game files, screenshots and source zips from Netlify Blobs.
// Routes:
//   /uploads/game/:id/<path...>  -> game-assets store, key games/:id/<path...>
//   /uploads/screenshot/:name    -> screenshots store, key <name>
//   /uploads/source/:id          -> game-assets store, key games/:id/source.zip
import { getStore } from '@netlify/blobs';

function notFound() {
  return new Response('Not found', { status: 404 });
}

export default async function uploads(req, context) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/uploads\//, '').split('/').filter(Boolean);

  if (parts.length === 0) return notFound();

  // /uploads/source/:id
  if (parts[0] === 'source' && parts.length === 2) {
    const id = parts[1];
    const store = getStore('game-assets');
    const buf = await store.get(`games/${id}/source.zip`, { type: 'arrayBuffer' });
    if (!buf) return notFound();
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="source-${id}.zip"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  // /uploads/screenshot/:name
  if (parts[0] === 'screenshot' && parts.length === 2) {
    const name = decodeURIComponent(parts[1]);
    const store = getStore('screenshots');
    const meta = await store.getMetadata(name);
    if (!meta) return notFound();
    const buf = await store.get(name, { type: 'arrayBuffer' });
    if (!buf) return notFound();
    const contentType = (meta.metadata && meta.metadata.contentType) || 'image/png';
    return new Response(buf, {
      status: 200,
      headers: { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' },
    });
  }

  // /uploads/game/:id/<path...>
  if (parts[0] === 'game' && parts.length >= 2) {
    const id = parts[1];
    const rel = parts.slice(2).join('/');
    if (!rel) return notFound();
    const key = `games/${id}/${decodeURIComponent(rel)}`;
    const store = getStore('game-assets');
    const meta = await store.getMetadata(key);
    if (!meta) return notFound();
    const buf = await store.get(key, { type: 'arrayBuffer' });
    if (!buf) return notFound();
    const contentType = (meta.metadata && meta.metadata.contentType) || guessContentType(rel);
    return new Response(buf, {
      status: 200,
      headers: { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' },
    });
  }

  return notFound();
}

function guessContentType(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript',
    css: 'text/css', json: 'application/json', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    otf: 'font/otf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    mp4: 'video/mp4', webm: 'video/webm', txt: 'text/plain', xml: 'application/xml',
  };
  return map[ext] || 'application/octet-stream';
}

export const config = { path: '/uploads/*' };
