/* PRIVATE AI keeper (Cloudflare Worker). Your public website contains NO AI settings and NO key.
   One-time setup:
   1) Workers & Pages -> KV -> create a namespace, bind it to this worker as  AI_KV
   2) Settings -> Variables -> add secret  ADMIN_PASSWORD  (your own long password)
   3) Open  https://YOUR-WORKER-ADDRESS/admin , enter the password, paste your API key, Save. Done forever.
   Optional variable ALLOWED_ORIGIN = https://yoursite.com  (only your site may use the scanner) */
const SYSTEM = 'You are a crypto market scanner. Input rows are [symbol, price, change24h%, change1h%, volumeSpikeRatio, volume24hUSD]. Pick up to 8 of the most notable setups using ONLY the given data. Reply with JSON only, no markdown: {"picks":[{"s":"BTCUSDT","bias":"bull|bear|neutral","score":0-100,"why":"max 12 words"}]}. This is information, not financial advice.';
const SYSTEM_G = 'You read one market gauge: a symbol with per-timeframe technical scores from -1 (strong sell) to +1 (strong buy), indicator buy/sell counts, and momentum delta. Reply with JSON only, no markdown: {"verdict":{"bias":"bull|bear|neutral","score":0-100,"why":"max 25 words","plan":"max 25 words on what to wait for or watch"}}. Use ONLY the given data. This is information, not financial advice.';
const SYSTEM_C = 'You are a friendly trading-chart assistant inside a charting app. Chat naturally and keep each answer under 120 words. Use ONLY the chart data provided (symbol, timeframe, recent candles, indicators); if something is not in the data, say so. Explain levels, trend, momentum and risks. Never promise outcomes and never give financial advice; remind the user it is information only when they ask for trades.';
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kvPut = (env, ...a) => env.AI_KV ? kvPut(env, ...a) : Promise.resolve();   // storage is optional
const cfgGet = async env => {
  // SIMPLE SETUP: add one secret named API_KEY in Cloudflare (Settings -> Variables and Secrets). No storage needed.
  const base = { key: env.API_KEY, model: env.MODEL, alert: env.ALERT_URL, enabled: true };
  if (!env.AI_KV) return base;
  try { const c = JSON.parse(await env.AI_KV.get('cfg') || '{}'); return env.API_KEY ? { ...c, key: env.API_KEY, model: c.model || env.MODEL } : c; } catch (e) { return base; }
};

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
    let rows, gauge, chat; try { const b = await req.json(); gauge = b.gauge; rows = b.rows; chat = b.chat; if (chat) { const m = chat.messages; if (!Array.isArray(m) || !m.length || m.length > 12 || m.some(x => !x || (x.role !== 'user' && x.role !== 'assistant') || typeof x.content !== 'string' || x.content.length > 1500) || m[m.length - 1].role !== 'user' || JSON.stringify(chat.ctx || {}).length > 7000) throw 0; } else if (gauge) { if (typeof gauge !== 'object' || JSON.stringify(gauge).length > 3000) throw 0; } else if (!Array.isArray(rows) || rows.length > 60) throw 0; } catch (e) { return out({ ok: false }); }

    if (chat && env.AI_KV) {   // chat is never cached, so protect your credit: per-visitor and daily limits
      const ip = req.headers.get('CF-Connecting-IP') || 'x', hr = Math.floor(Date.now() / 3600000), day = Math.floor(Date.now() / 86400000);
      const kh = 'rl:' + ip + ':' + hr, kd = 'cap:' + day;
      const nh = +(await env.AI_KV.get(kh) || 0), nd = +(await env.AI_KV.get(kd) || 0);
      if (nh >= +(env.CHAT_PER_HOUR || 20) || nd >= +(env.CHAT_PER_DAY || 1000)) return out({ ok: false, limit: true });
      ctx.waitUntil(kvPut(env, kh, String(nh + 1), { expirationTtl: 3700 })); ctx.waitUntil(kvPut(env, kd, String(nd + 1), { expirationTtl: 90000 }));
    }
    const SYS = chat ? SYSTEM_C + ' Chart data (JSON): ' + JSON.stringify(chat.ctx || {}) : (gauge ? SYSTEM_G : SYSTEM);
    const MSGS = chat ? chat.messages : [{ role: 'user', content: JSON.stringify(gauge || rows) }];
    const ckey = new Request('https://ai-cache/' + Math.floor(Date.now() / 300000) + '/' + (gauge ? 'g' + JSON.stringify(gauge) : rows.map(r => r[0]).sort().join(',')));
    const hit = chat ? null : await caches.default.match(ckey); if (hit) return new Response(hit.body, { headers: cors });
    try {
      const groq = cfg.key.startsWith('gsk_');   // Groq keys start with gsk_, Anthropic keys with sk-ant
      const r = groq
        ? await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + cfg.key },
            body: JSON.stringify({ model: cfg.model || 'llama-3.3-70b-versatile', max_tokens: chat ? 500 : 900, messages: [{ role: 'system', content: SYS }, ...MSGS] }) })
        : await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: cfg.model || 'claude-sonnet-5-5', max_tokens: chat ? 500 : 900, system: SYS, messages: MSGS }) });
      const j = await r.json();
      if (!r.ok) {
        const t = JSON.stringify(j).toLowerCase();
        if (r.status === 401 || r.status === 402 || t.includes('credit') || t.includes('billing')) {
          ctx.waitUntil(kvPut(env, 'cfg', JSON.stringify({ ...cfg, problem: 'Top-up needed or key invalid (' + new Date().toISOString().slice(0, 16) + ' UTC)' })));
          if (cfg.alert) ctx.waitUntil(fetch(cfg.alert, { method: 'POST', body: 'AI scanner: top-up needed' }).catch(() => {}));
        }
        return out({ ok: false });
      }
      const t = groq ? ((j.choices && j.choices[0] && j.choices[0].message.content) || '') : (j.content || []).map(c => c.text || '').join('');
      if (chat) { if (cfg.problem) ctx.waitUntil(kvPut(env, 'cfg', JSON.stringify({ ...cfg, problem: '' }))); return t.trim() ? out({ ok: true, reply: t.trim().slice(0, 1500) }) : out({ ok: false }); }
      const parsed = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); const picks = parsed.picks || []; const verdict = parsed.verdict;
      if (gauge && !verdict) return out({ ok: false });
      if (cfg.problem) ctx.waitUntil(kvPut(env, 'cfg', JSON.stringify({ ...cfg, problem: '' })));   // works again, clear the warning
      const res = new Response(JSON.stringify(gauge ? { ok: true, verdict } : { ok: true, picks }), { headers: { ...cors, 'Cache-Control': 'max-age=300' } });
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
    await kvPut(env, 'cfg', JSON.stringify(cfg));
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
