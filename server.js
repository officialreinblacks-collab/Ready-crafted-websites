// MarketPlusView push server: scans the market 24/7 with the Market Scanner engine and sends
// Web Push notifications to phones, even when the app is closed.
const http=require('http'), fs=require('fs'), path=require('path'), webpush=require('web-push'), mkEngine=require('./engine.js');
const PORT=+process.env.PORT||8787, DIR=process.env.DATA_DIR||__dirname, EVERY=(+process.env.SCAN_SECONDS||30)*1000, MAX_SUBS=200, MAX_WATCH=20;
// ---- Plan enforcement (server side) ----
// The phone sends its Supabase login token; we ask Supabase who it is and what plan it has. Nothing the browser says about its plan is trusted.
const SB_URL=process.env.SB_URL||'https://ssukfrvtknfsccqxqkjh.supabase.co', SB_KEY=process.env.SB_KEY||'sb_publishable_qjmaCvag0XhnMlipWFHCeA_fwt3CqST';
const PUSH_PLANS={trial:1,pro:1};   // plans allowed to receive Buy/Sell strategy push signals. Add new plan names here.
async function entitlement(token){
  if(!token||typeof token!=='string'||token.length>4096) return {code:401,error:'sign in required'};
  const H={apikey:SB_KEY,Authorization:'Bearer '+token,'Content-Type':'application/json'};
  try{
    const u=await fetch(SB_URL+'/auth/v1/user',{headers:H}); if(!u.ok) return {code:401,error:'invalid session'};
    const user=await u.json(); if(!user||!user.id) return {code:401,error:'invalid session'};
    const a=await fetch(SB_URL+'/rest/v1/rpc/is_admin',{method:'POST',headers:H,body:'{}'});
    if(a.ok&&(await a.json())===true) return {ok:true,uid:user.id,plan:'admin',exp:null};
    const m=await fetch(SB_URL+'/rest/v1/memberships?select=plan,expires_at&user_id=eq.'+encodeURIComponent(user.id)+'&limit=1',{headers:H});
    if(!m.ok) return {code:503,error:'membership lookup failed'};
    const row=(await m.json())[0]; if(!row) return {code:403,error:'no active plan',needs:'pro'};
    const exp=new Date(row.expires_at).getTime();
    if(!(exp>Date.now())) return {code:403,error:'plan expired',needs:'renew'};          // checked on the server clock
    if(!PUSH_PLANS[row.plan]) return {code:403,error:'plan does not include signals',needs:'pro'};
    return {ok:true,uid:user.id,plan:row.plan,exp};
  }catch(e){ return {code:503,error:'auth unavailable'}; } }
const live=s=>!!s.uid&&(s.exp===null||s.exp>Date.now());   // old subscriptions with no verified user stay dormant until the app re-registers them
const F=n=>path.join(DIR,n), load=(n,d)=>{ try{ return JSON.parse(fs.readFileSync(F(n),'utf8')); }catch(e){ return d; } }, save=(n,v)=>{ try{ fs.writeFileSync(F(n),JSON.stringify(v)); }catch(e){ console.error('save failed',n,e.message); } };
let vapid=process.env.VAPID_PUBLIC&&process.env.VAPID_PRIVATE?{publicKey:process.env.VAPID_PUBLIC,privateKey:process.env.VAPID_PRIVATE}:load('vapid.json',null);
if(!vapid){ vapid=webpush.generateVAPIDKeys(); save('vapid.json',vapid); }
webpush.setVapidDetails(process.env.VAPID_SUBJECT||'mailto:admin@example.com',vapid.publicKey,vapid.privateKey);
let subs=load('subs.json',{});   // endpoint -> {sub, watches:[{symbol,interval,opts}], seen:{key:1}}
const engines={}, eng=iv=>engines[iv]||(engines[iv]=mkEngine(iv)), BASES=['https://api.binance.com','https://data-api.binance.vision'];
const num=v=>v==null||isNaN(v)?'-':v<1?v.toFixed(5):v<100?v.toFixed(3):v.toFixed(2);
async function klines(sym,iv){ for(const b of BASES){ try{ const r=await fetch(`${b}/api/v3/klines?symbol=${sym}&interval=${iv}&limit=500`); if(!r.ok) continue; const k=await r.json();
  if(Array.isArray(k)&&k.length>60) return k.map(x=>({time:Math.floor(x[0]/1000),open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[5]})); }catch(e){} } return null; }
function events(sym,iv,c,r){ const last=c.length-1, ev=[], tag=sym+' '+iv, t=c[last].time;
  const a=r.pos&&r.pos.i0===last?r.pos:(r.pend&&r.pend.i0===last?r.pend:null);
  if(a) ev.push({key:`${sym}|${iv}|open|${t}`,title:(a.side>0?'🟢 BUY ':'🔴 SELL ')+(r.pos?'':'LIMIT ')+tag,body:`Entry ${num(a.e)} · SL ${num(a.sl0)} · TP1 ${num(a.t[0])} · TP2 ${num(a.t[1])} · TP3 ${num(a.t[2])} · score ${a.score}`});
  const x=r.trades[r.trades.length-1]; if(x&&x.i1===last) ev.push({key:`${sym}|${iv}|close|${x.i0}|${t}`,title:(x.tag==='TP3'?'✅ TP3 hit ':x.tag==='BE'?'➖ Breakeven ':'🛑 SL hit ')+tag,body:`${x.side>0?'BUY':'SELL'} closed ${x.R>=0?'+':''}${x.R.toFixed(2)}R`});
  return ev; }
let busy=false;
async function scan(){ if(busy) return; busy=true; try{
  const jobs={}; Object.values(subs).filter(live).forEach(s=>s.watches.forEach(w=>{ const k=w.symbol+'|'+w.interval+'|'+JSON.stringify(w.opts||{}); jobs[k]=jobs[k]||w; }));
  const res={}, kl={};
  for(const k of Object.keys(jobs)){ const w=jobs[k], id=w.symbol+'|'+w.interval; if(!kl[id]) kl[id]=await klines(w.symbol,w.interval); if(!kl[id]) continue;
    const c=kl[id].slice(0,-1); try{ res[k]=events(w.symbol,w.interval,c,eng(w.interval)(c,w.opts||{})); }catch(e){ console.error('scan',k,e.message); } }
  for(const [ep,s] of Object.entries(subs).filter(e=>live(e[1]))) for(const w of s.watches){ const evs=res[w.symbol+'|'+w.interval+'|'+JSON.stringify(w.opts||{})]||[];
    for(const e of evs){ if(s.seen[e.key]) continue; s.seen[e.key]=1;
      try{ await webpush.sendNotification(s.sub,JSON.stringify({title:e.title,body:e.body,tag:e.key})); console.log('sent',e.title); }
      catch(err){ if(err.statusCode===404||err.statusCode===410){ delete subs[ep]; break; } console.error('push failed',err.statusCode||err.message); } } }
  Object.values(subs).forEach(s=>{ const k=Object.keys(s.seen); if(k.length>300) k.slice(0,k.length-200).forEach(x=>delete s.seen[x]); });
  save('subs.json',subs); }catch(e){ console.error('scan error',e.message); } busy=false; }
const send=(res,code,obj)=>{ res.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}); res.end(JSON.stringify(obj)); };
const clean=w=>(Array.isArray(w)?w:[]).slice(0,MAX_WATCH).filter(x=>x&&/^[A-Z0-9]{5,20}$/.test(x.symbol)&&/^\d+[mhdwM]$/.test(x.interval)).map(x=>({symbol:x.symbol,interval:x.interval,opts:x.opts&&typeof x.opts==='object'?x.opts:{}}));
let cal={t:0,j:null};   // Forex Factory weekly calendar, cached so phones don't hit the feed's rate limit
async function calendar(){ if(cal.j&&Date.now()-cal.t<15*60e3) return cal.j;
  try{ const r=await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json',{headers:{'User-Agent':'Mozilla/5.0'}}); if(r.ok){ const j=await r.json(); if(Array.isArray(j)&&j.length){ cal={t:Date.now(),j}; return j; } } }catch(e){ console.error('calendar fetch failed',e.message); }
  return cal.j; }
http.createServer((req,res)=>{ if(req.method==='OPTIONS') return send(res,204,{});
  if(req.method==='GET'&&req.url.split('?')[0]==='/calendar') return calendar().then(j=>j?send(res,200,j):send(res,502,{error:'feed unavailable'}));
  if(req.url==='/vapid') return send(res,200,{publicKey:vapid.publicKey});
  if(req.url==='/health') return send(res,200,{ok:true,subscribers:Object.keys(subs).length});
  if(req.method!=='POST') return send(res,404,{error:'not found'});
  let raw=''; req.on('data',d=>{ raw+=d; if(raw.length>1e5) req.destroy(); });
  req.on('end',async()=>{ let b; try{ b=JSON.parse(raw||'{}'); }catch(e){ return send(res,400,{error:'bad json'}); }
    const ep=b.subscription&&b.subscription.endpoint||b.endpoint;
    if(req.url==='/subscribe'){ if(!ep||!b.subscription||!b.subscription.keys) return send(res,400,{error:'no subscription'});
      const ent=await entitlement(b.token); if(!ent.ok) return send(res,ent.code,{error:ent.error,needs:ent.needs});
      if(!subs[ep]&&Object.keys(subs).length>=MAX_SUBS) return send(res,429,{error:'full'});
      subs[ep]={sub:b.subscription,watches:clean(b.watches),seen:(subs[ep]&&subs[ep].seen)||{},uid:ent.uid,exp:ent.exp}; save('subs.json',subs); scan(); return send(res,200,{ok:true,watching:subs[ep].watches.length}); }
    if(req.url==='/unsubscribe'){ delete subs[ep]; save('subs.json',subs); return send(res,200,{ok:true}); }
    if(req.url==='/test'){ const s=subs[ep]; if(!s) return send(res,404,{error:'not subscribed'});
      try{ await webpush.sendNotification(s.sub,JSON.stringify({title:'✅ Push works',body:'MarketPlusView server can reach this phone.',tag:'test'+Date.now()})); return send(res,200,{ok:true}); }catch(e){ return send(res,500,{error:String(e.statusCode||e.message)}); } }
    send(res,404,{error:'not found'}); }); }).listen(PORT,()=>{ console.log('push server on',PORT,'| scanning every',EVERY/1000,'s'); setInterval(scan,EVERY); scan(); });
