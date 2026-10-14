/**
 * One origin scenario, run in its own process.
 *
 * api/data.js reads APP_ORIGIN into a module-level const, so a single process
 * can only ever test one configuration. The original test deleted APP_ORIGIN
 * and exercised the built-in fallback — which is exactly why it passed while
 * production was refusing every write: the variable overrides the fallback, so
 * the fallback is only read when nobody has set the variable at all.
 *
 * Env in:  APP_ORIGIN (optional), CASE_METHOD, CASE_ORIGIN, CASE_HOST
 * Std out: the response status code, then the Access-Control-Allow-Origin header
 */
process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'token';
if (!process.env.APP_ORIGIN) delete process.env.APP_ORIGIN;

global.fetch = async () => ({
  ok: true,
  json: async () => Array.from({ length: 12 }, () => ({ result: null })),
});

const handler = require('../api/data.js');

const res = { headers: {}, code: null };
res.setHeader = (k, v) => { res.headers[k] = v; };
res.status = c => { res.code = c; return res; };
res.json = () => res;
res.end = () => res;

const headers = {};
if (process.env.CASE_ORIGIN) headers.origin = process.env.CASE_ORIGIN;
if (process.env.CASE_HOST)   headers.host   = process.env.CASE_HOST;

handler({ method: process.env.CASE_METHOD || 'GET', query: {}, headers, body: {} }, res)
  .then(() => {
    console.log(res.code);
    console.log(res.headers['Access-Control-Allow-Origin'] || '');
  });
