'use strict';
/**
 * Test harness: loads the REAL route files with a fake express Router and a
 * programmable fake `sql` tagged template. Auth middleware runs for real
 * (jsonwebtoken is stubbed so the "token" is just JSON).
 */
const Module = require('module');
process.env.DATABASE_URL = 'postgres://fake';
process.env.JWT_SECRET = 'x';

const state = { handlers: [], calls: [] };
const norm = (s) => s.replace(/\s+/g, ' ').trim();

function fakeSql(strings, ...values) {
  const text = norm(strings.join('?'));
  state.calls.push({ text, values });
  for (const h of state.handlers) if (h.re.test(text)) return Promise.resolve(h.fn(values, text));
  return Promise.resolve([]);
}
fakeSql.query = fakeSql;

function Router() {
  const routes = [];
  const flat = (a) => a.flat(Infinity);
  const r = { routes };
  for (const m of ['get', 'post', 'put', 'delete']) {
    r[m] = (path, ...hs) => { routes.push({ method: m.toUpperCase(), path, handlers: flat(hs) }); return r; };
  }
  return r;
}
const fakeExpress = () => ({ Router });
fakeExpress.Router = Router;

const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'express') return fakeExpress;
  if (req === '@neondatabase/serverless') return { neon: () => fakeSql };
  if (req === 'dotenv') return { config() {} };
  if (req === 'jsonwebtoken') return { verify: (t) => { try { return JSON.parse(t); } catch { throw new Error('bad'); } }, sign: () => 'tok' };
  if (req === 'bcryptjs') return { hash: async (x) => 'H(' + x + ')', compare: async (a, b) => b === 'H(' + a + ')' };
  return realLoad.apply(this, arguments);
};

const load = (p) => require(require('path').join(__dirname, '..', p));

// Register a fake DB responder. Later registrations win.
const on = (re, fn) => state.handlers.unshift({ re, fn: typeof fn === 'function' ? fn : () => fn });
const reset = () => { state.handlers.length = 0; state.calls.length = 0; };
const calls = (re) => state.calls.filter((c) => re.test(c.text));

function match(route, method, url) {
  if (route.method !== method) return null;
  const names = [];
  const rx = new RegExp('^' + route.path.replace(/:([A-Za-z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
  const m = rx.exec(url);
  if (!m) return null;
  return Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
}

async function call(router, method, url, { user, body, query } = {}) {
  let params = null, route = null;
  for (const r of router.routes) { const p = match(r, method, url); if (p) { params = p; route = r; break; } }
  if (!route) throw new Error(`No route ${method} ${url}`);
  const req = {
    params, body: body || {}, query: query || {}, ip: '1.1.1.1',
    headers: user ? { authorization: 'Bearer ' + JSON.stringify(user) } : {},
  };
  const res = { statusCode: 200, body: undefined, done: false,
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.done = true; return this; } };
  for (const h of route.handlers) {
    if (res.done) break;
    let nextCalled = false;
    await new Promise((resolve, reject) => {
      const next = (e) => { nextCalled = true; e ? reject(e) : resolve(); };
      Promise.resolve(h(req, res, next)).then(() => { if (!nextCalled) resolve(); }, reject);
    });
    if (!nextCalled) break;
  }
  return { status: res.statusCode, body: res.body };
}

module.exports = { load, on, reset, calls, call, state };
