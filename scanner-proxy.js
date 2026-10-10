/* PRIVATE AI keeper (Cloudflare Worker). Your public website contains NO AI settings and NO key.
   One-time setup:
   1) Workers & Pages -> KV -> create a namespace, bind it to this worker as  AI_KV
   2) Settings -> Variables -> add secret  ADMIN_PASSWORD  (your own long password)
   3) Open  https://YOUR-WORKER-ADDRESS/admin , enter the password, paste your API key, Save. Done forever.
   Optional variable ALLOWED_ORIGIN = https://yoursite.com  (only your site may use the scanner) */
const SYSTEM = 'You are a crypto market scanner. Input rows are [symbol, price, change24h%, change1h%, volumeSpikeRatio, volume24hUSD]. Pick up to 8 of the most notable setups using ONLY the given data. Reply with JSON only, no markdown: {"picks":[{"s":"BTCUSDT","bias":"bull|bear|neutral","score":0-100,"why":"max 12 words"}]}. This is information, not financial advice.';
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cfgGet = async env => { try { return JSON.parse(await env.AI_KV.get('cfg') || '{}'); } catch (e) { return {}; } };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/admin') return admin(req, env);
    const origin = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
    const out = o => new Response(JSON.stringify(o), { headers: cors });   // always HTTP 200, visitors never see raw errors
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST' || (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN)) return out({ ok: false });

    const cfg = await cfgGet(env);
    if (!cfg.key || cfg.enabled === false) return out({ ok: false });
    let rows; try { rows = (await req.json()).rows; if (!Array.isArray(rows) || rows.length > 60) throw 0; } catch (e) { return out({ ok: false }); }

    const ckey = new Request('https://ai-cache/' + Math.floor(Date.now() / 300000) + '/' + rows.map(r => r[0]).sort().join(','));
    const hit = await caches.default.match(ckey); if (hit) return new Response(hit.body, { headers: cors });
    try {
      const groq = cfg.key.startsWith('gsk_');   // Groq keys start with gsk_, Anthropic keys with sk-ant
      const r = groq
        ? await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + cfg.key },
            body: JSON.stringify({ model: cfg.model || 'llama-3.3-70b-versatile', max_tokens: 900, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(rows) }] }) })
        : await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: cfg.model || 'claude-sonnet-5-5', max_tokens: 900, system: SYSTEM, messages: [{ role: 'user', content: JSON.stringify(rows) }] }) });
      const j = await r.json();
      if (!r.ok) {
        const t = JSON.stringify(j).toLowerCase();
        if (r.status === 401 || r.status === 402 || t.includes('credit') || t.includes('billing')) {
          ctx.waitUntil(env.AI_KV.put('cfg', JSON.stringify({ ...cfg, problem: 'Top-up needed or key invalid (' + new Date().toISOString().slice(0, 16) + ' UTC)' })));
          if (cfg.alert) ctx.waitUntil(fetch(cfg.alert, { method: 'POST', body: 'AI scanner: top-up needed' }).catch(() => {}));
        }
        return out({ ok: false });
      }
      const t = groq ? ((j.choices && j.choices[0] && j.choices[0].message.content) || '') : (j.content || []).map(c => c.text || '').join('');
      const picks = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)).picks || [];
      if (cfg.problem) ctx.waitUntil(env.AI_KV.put('cfg', JSON.stringify({ ...cfg, problem: '' })));   // works again, clear the warning
      const res = new Response(JSON.stringify({ ok: true, picks }), { headers: { ...cors, 'Cache-Control': 'max-age=300' } });
      ctx.waitUntil(caches.default.put(ckey, res.clone())); return res;
    } catch (e) { return out({ ok: false }); }
  }
};

async function admin(req, env) {
  const H = { 'Content-Type': 'text/html;charset=utf-8', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' };
  const page = (body) => new Response('<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content=noindex><body style="font:16px system-ui;max-width:460px;margin:30px auto;padding:0 16px;background:#111;color:#eee"><h2>AI settings (private)</h2>' + body, { headers: H });
  if (req.method !== 'POST') return page('<form method=post><input type=password name=pw placeholder="Admin password" style="width:100%;padding:10px"><br><br><button style="padding:10px 18px">Open</button></form>');
  const f = await req.formData(), ok = env.ADMIN_PASSWORD && f.get('pw') === env.ADMIN_PASSWORD;
  if (!ok) return page('<p style="color:#f66">Wrong password.</p>');
  let cfg = await cfgGet(env);
  if (f.get('save')) {
    const nk = String(f.get('key') || '').trim();
    cfg = { key: nk || cfg.key, model: String(f.get('model') || '').trim(), enabled: f.get('enabled') === 'on', alert: String(f.get('alert') || '').trim(), problem: nk ? '' : cfg.problem };
    await env.AI_KV.put('cfg', JSON.stringify(cfg));
  }
  const st = cfg.key ? 'Key saved ending …' + esc(cfg.key.slice(-4)) : 'No key saved yet';
  const inp = 'style="width:100%;padding:10px;margin:4px 0 12px"';
  return page(`<p>${st}${cfg.problem ? '<br><b style="color:#f66">⚠ ' + esc(cfg.problem) + '</b>' : ''}</p>
  <form method=post><input type=hidden name=pw value="${esc(f.get('pw'))}"><input type=hidden name=save value=1>
  API key (leave empty to keep the saved one)<input name=key type=password ${inp}>
  Model (optional)<input name=model value="${esc(cfg.model)}" placeholder="claude-sonnet-5-5" ${inp}>
  Phone alert URL when top-up needed (optional, e.g. https://ntfy.sh/your-topic)<input name=alert value="${esc(cfg.alert)}" ${inp}>
  <label><input type=checkbox name=enabled ${cfg.enabled === false ? '' : 'checked'}> AI scanner on</label><br><br><button style="padding:10px 18px">Save</button></form>`);
}
