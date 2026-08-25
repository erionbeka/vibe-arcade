// Catch-all Netlify Function that proxies /api/* to the Express app.
// Uses serverless-http so the existing Express routes keep working unchanged.
import serverless from 'serverless-http';
import { app } from '../../server.js';

const base = serverless(app);
async function handler(event, context) {
  context.callbackWaitsForEmptyEventLoop = false;
  return base(event, context);
}

export default async function api(req, context) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  let body = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const buf = await req.arrayBuffer();
    body = Buffer.from(buf).toString('base64');
  }

  const headers = {};
  req.headers.forEach((value, key) => { headers[key] = value; });

  const event = {
    httpMethod: method,
    path,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    multiValueQueryStringParameters: {},
    headers,
    multiValueHeaders: {},
    body,
    isBase64Encoded: true,
    requestContext: { http: { method, path }, domainName: url.host },
    resource: '/{proxy+}',
    pathParameters: { proxy: path.replace(/^\//, '') },
  };

  const result = await handler(event, context);

  const responseHeaders = new Headers();
  for (const [k, v] of Object.entries(result.headers || result.multiValueHeaders || {})) {
    if (Array.isArray(v)) {
      for (const item of v) responseHeaders.append(k, item);
    } else {
      responseHeaders.set(k, v);
    }
  }
  let responseBody = result.body || '';
  if (result.isBase64Encoded) {
    const bin = Buffer.from(responseBody, 'base64');
    return new Response(bin, { status: result.statusCode || 200, headers: responseHeaders });
  }
  return new Response(responseBody, { status: result.statusCode || 200, headers: responseHeaders });
}

export const config = { path: '/api/*' };
