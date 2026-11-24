// JLI Messenger Chatbot — v2 AI-first, human-like (ManyChat-style)
// Page: Japanese Language Institute–JLI, Mirpur-10
// Built 24 Nov 2026 for Md Jahid Hasan. Updated same day: AI-first + instant reply.
// No npm dependencies — only Node built-ins. Run: node server.js
// Flow is from the 19 Nov 2026 JLI ready-to-post pack (auto-reply script §6).
// IMPORTANT: fee / batch date / trial date are PLACEHOLDERS until Md gives the
// real numbers. Never post the 15,000 -> 10,500 market example as JLI's price.
// Human-like = OpenAI API key thakle AI jobab dibe; key na thakle rule-based
// menu cholbe (robotic lagbe). Instant = webhook-e age 200 OK, tarpor reply;
// AI 6s-er beshi lagle sathe sathe rule-based fallback jabe, late hobe na.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'jli-verify-2026';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v21.0';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '6000', 10);
const DRY_RUN = !PAGE_ACCESS_TOKEN || process.env.DRY_RUN === 'true';
const AI_ON = Boolean(OPENAI_API_KEY);

// --- JLI facts: fill from .env, defaults are placeholders on purpose ---
const CFG = {
  whatsapp: process.env.JLI_WHATSAPP || '01861-292214',
  address: 'Level-4, Plot-12, Road-1, Mirpur-10, Dhaka',
  feeActual: process.env.JLI_FEE_ACTUAL || '[আসল ফি]',
  feeDiscounted: process.env.JLI_FEE_DISCOUNTED || '[ছাড়ের ফি]',
  batchDate: process.env.JLI_BATCH_DATE || '[ব্যাচ শুরুর তারিখ]',
  deadline: process.env.JLI_DEADLINE || '[ভর্তির শেষ তারিখ]',
  trialDate: process.env.JLI_TRIAL_DATE || '[ট্রায়াল ক্লাসের তারিখ, সময়]',
  seats: process.env.JLI_SEATS || '[২০]',
};
const FACTS_KNOWN = !CFG.feeActual.startsWith('[');

const DATA_DIR = __dirname;
const LEADS_JSON = path.join(DATA_DIR, 'leads.json');
const LEADS_CSV = path.join(DATA_DIR, 'leads.csv');
const OUTBOX_LOG = path.join(DATA_DIR, 'outbox.log');

// --- state: psid -> { stage, interest, name, phone, hsc, mode, history[] } ---
const sessions = new Map();
function session(psid) {
  if (!sessions.has(psid)) sessions.set(psid, { stage: 'new', interest: '', phone: '', hsc: '', mode: '', history: [] });
  return sessions.get(psid);
}
function pushHistory(s, role, content) {
  s.history.push({ role, content: String(content).slice(0, 500) });
  if (s.history.length > 10) s.history = s.history.slice(-10);
}

// --- leads storage ---
function loadLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_JSON, 'utf8')); } catch { return []; }
}
function saveLead(lead) {
  const leads = loadLeads();
  lead.time = new Date().toISOString();
  leads.push(lead);
  fs.writeFileSync(LEADS_JSON, JSON.stringify(leads, null, 2));
  const row = [lead.time, lead.psid, lead.phone || '', lead.name || '', lead.interest || '', lead.hsc || '', lead.mode || '', (lead.lastMessage || '').replace(/[\r\n,]+/g, ' ')].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n';
  if (!fs.existsSync(LEADS_CSV)) fs.writeFileSync(LEADS_CSV, 'time,psid,phone,name,interest,hsc,mode,last_message\n');
  fs.appendFileSync(LEADS_CSV, row);
  return lead;
}
function logOutbox(psid, text) {
  fs.appendFileSync(OUTBOX_LOG, `${new Date().toISOString()} | ${psid} | ${text.replace(/\n/g, ' / ')}\n`);
}

// --- phone detection (Bangladesh) ---
function extractPhone(text) {
  const m = String(text || '').replace(/[\s-]/g, '').match(/(?:\+?880|0)?1[3-9]\d{8}/);
  if (!m) return null;
  let p = m[0];
  if (p.startsWith('+880')) p = '0' + p.slice(4);
  else if (p.startsWith('880')) p = '0' + p.slice(3);
  else if (!p.startsWith('0')) p = '0' + p;
  return p.length === 11 ? p : null;
}

// --- rule-based replies (fast fallback — also the no-AI-key mode) ---
const GREETING = `আসসালামু আলাইকুম! Japanese Language Institute–JLI-তে মেসেজ করার জন্য ধন্যবাদ। 🇯🇵
N5 ব্যাচ: ক্লাস শুরু ${CFG.batchDate}, ফি ৳${CFG.feeActual} → ৩০% ছাড়ে ৳${CFG.feeDiscounted} (${CFG.deadline} পর্যন্ত)।
আপনি কী জানতে চান? নিচের একটি নম্বর লিখুন:
1️⃣ N5 ফি ও ব্যাচ
2️⃣ ফ্রি ট্রায়াল ক্লাস
3️⃣ স্টুডেন্ট ভিসা
4️⃣ TITP/SSW (জব ভিসা)
5️⃣ কাউন্সেলরের সাথে কথা বলব`;

const PRICE_REPLY = `N5 ব্যাচ — ভর্তি চলছে 🇯🇵
📚 কোর্স: JLPT N5 — অনলাইন + অফলাইন, মিরপুর-১০
🗓️ ক্লাস শুরু: ${CFG.batchDate}
💰 ফি: ৳${CFG.feeActual} → ৩০% ছাড়ে ৳${CFG.feeDiscounted} (${CFG.deadline} পর্যন্ত)
🪑 আসন মাত্র ${CFG.seats}টি
📍 ${CFG.address}
📲 WhatsApp: ${CFG.whatsapp}

আপনি অনলাইন নাকি অফলাইন ব্যাচ চান? আর HSC কোন বছরের?
আর আপনার ফোন নম্বরটা লিখুন — আপনার সিটটি ধরে রাখবো।`;

const TRIAL_REPLY = `🎌 ফ্রি ট্রায়াল ক্লাস — ১ ঘণ্টায় জাপানি পড়তে শিখুন!
🗓️ ${CFG.trialDate} | 📍 মিরপুর-১০ (অফলাইন) + অনলাইন
🪑 আসন সীমিত।

রেজিস্ট্রেশনের জন্য আপনার নাম + ফোন নম্বরটা লিখুন — লিংক ইনবক্সে পাঠিয়ে দেবো।
WhatsApp: ${CFG.whatsapp}`;

const VISA_REPLY = `❓ N5 শিখে কি জাপান যাওয়া যায়?
হ্যাঁ — N5-ই প্রথম ধাপ। তারপর N4, তারপর আপনার রুট অনুযায়ী স্টুডেন্ট ভিসা, TITP বা SSW (জব ভিসা)।

JLI-তে N5 → N4 একই জায়গায় শিখে ভিসা কাউন্সেলিং ফ্রি পাবেন।

কোন সেশনে যেতে চান — এপ্রিল না অক্টোবর? আর আপনার ফোন নম্বরটা লিখুন, কাউন্সেলর কল করে বিস্তারিত জানিয়ে দেবে।`;

const JOB_REPLY = `TITP / SSW (জব ভিসা) — জাপানে কাজের রুট 🇯🇵
N5 → N4 শেষ করে TITP বা SSW-তে আবেদন করা যায়।

আপনার ফোন নম্বর + HSC সালটা লিখুন — কাউন্সেলর আপনার রুটটা মিলিয়ে জানিয়ে দেবে।
WhatsApp: ${CFG.whatsapp}`;

const ASK_PHONE = `আপনার ফোন নম্বরটা লিখুন (যেমন 01XXXXXXXXX) — তাহলে কাউন্সেলর আপনাকে কল করে বিস্তারিত জানিয়ে দেবে।`;
const HUMAN = `ধন্যবাদ! আপনার প্রশ্নটা কাউন্সেলরের কাছে পাঠিয়ে দিয়েছি — ২ কর্মঘণ্টার মধ্যে মানুষ জবাব দেবে। জরুরি হলে WhatsApp করুন: ${CFG.whatsapp}`;

function ruleReply(s, t) {
  if (['1', '১'].includes(t)) { s.interest = 'N5 fee/batch'; return PRICE_REPLY; }
  if (['2', '২'].includes(t)) { s.interest = 'trial'; s.stage = 'awaiting_phone'; return TRIAL_REPLY; }
  if (['3', '৩'].includes(t)) { s.interest = 'visa'; return VISA_REPLY; }
  if (['4', '৪'].includes(t)) { s.interest = 'TITP/SSW'; return JOB_REPLY; }
  if (['5', '৫'].includes(t)) { s.interest = 'counsellor'; s.stage = 'awaiting_phone'; return `অবশ্যই! কাউন্সেলরের সাথে কথা বলতে আপনার নাম + ফোন নম্বরটা লিখুন।\n${HUMAN}`; }
  if (/(n5|price|ফি|ভর্তি|admission|কত টাকা|খরচ|fee)/i.test(t)) { s.interest = 'N5 fee/batch'; return PRICE_REPLY; }
  if (/(trial|ট্রায়াল|ফ্রি ক্লাস|free class)/i.test(t)) { s.interest = 'trial'; s.stage = 'awaiting_phone'; return TRIAL_REPLY; }
  if (/(visa|ভিসা|student visa|স্টুডেন্ট)/i.test(t)) { s.interest = 'visa'; return VISA_REPLY; }
  if (/(titp|ssw|জব ভিসা|job visa|কাজের ভিসা)/i.test(t)) { s.interest = 'TITP/SSW'; return JOB_REPLY; }
  if (/(online|অনলাইন)/i.test(t)) s.mode = 'online';
  if (/(offline|অফলাইন)/i.test(t)) s.mode = 'offline';
  const hsc = t.match(/20\d\d/);
  if (hsc) s.hsc = hsc[0];
  if (s.mode || s.hsc) {
    s.stage = 'awaiting_phone';
    return `ঠিক আছে${s.mode ? ` — ${s.mode} ব্যাচ` : ''}${s.hsc ? `, HSC ${s.hsc}` : ''}।\n${ASK_PHONE}`;
  }
  if (s.stage === 'new') { s.stage = 'menu'; return GREETING; }
  return `${HUMAN}\n\nঅথবা নিচের একটি লিখুন: 1️⃣ ফি, 2️⃣ ট্রায়াল, 3️⃣ ভিসা, 4️⃣ জব ভিসা।`;
}

// --- AI brain: human-like, Bangla, short, one question at a time ---
function systemPrompt() {
  const feeLine = FACTS_KNOWN
    ? `N5 fee ৳${CFG.feeActual}, 30% discount-e ৳${CFG.feeDiscounted} (${CFG.deadline} porjonto). Batch shuru ${CFG.batchDate}, trial ${CFG.trialDate}, seat ${CFG.seats}ti.`
    : `Fee / batch date / trial date ekhono janano hoyni — kono dam ba tarikh BANIE bolbe na. Dam jante chaile bolbe "counsellor apnake call kore fee ta janiye dibe, apnar number ta din".`;
  return `Tumi JLI (Japanese Language Institute, Mirpur-10, Dhaka)-er Messenger counsellor, naam "JLI Team". Manusher moto kotha bolo, robot-er moto na.
- Bangla-e jobab dao (customer Bangla likhle Bangla, English likhle English). Choto jobab: beshirbhag somoy 2-3 line, ektai proshno ekbare.
- Menu barbar copy-paste korbe na. Customer ja jiggesh koreche, sudhu setar jobab dao, tarpor naturally ekta follow-up proshno koro.
- Customer agroho dekhale (fee, trial, visa, vorti) shohoje tar phone number chao: "apnar number ta dile counsellor call kore seat ta dhore rakhbe" — jor korbe na, ekbar chao.
- Tothyo: ${feeLine} WhatsApp ${CFG.whatsapp}. Thikana: ${CFG.address}. Course: JLPT N5, online + offline. N5 -> N4 -> student visa / TITP / SSW.
- Dam, tarikh, seat, pass-er har, visa success — ja janona ta banabe na. Jotil proshno (COE reject, document, gap, boyosh) hole bolbe counsellor 2 kormoghontar modhye janabe.
- Kokhono bolbe na tumi AI / bot / ChatGPT.`;
}

async function askAI(s, userText) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: AI_MODEL,
        temperature: 0.7,
        max_tokens: 220,
        messages: [{ role: 'system', content: systemPrompt() }, ...s.history, { role: 'user', content: userText }],
      }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `OpenAI ${res.status}`);
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } finally { clearTimeout(timer); }
}

// --- brain: phone first, then AI-first, then rule fallback (never late) ---
async function handleMessage(psid, text) {
  const s = session(psid);
  const t = String(text || '').trim();
  pushHistory(s, 'user', t);

  // 1. Phone number anywhere -> save at once (AI-er agei, kokhono miss hobe na)
  const phone = extractPhone(t);
  if (phone) {
    s.phone = phone;
    s.stage = 'done';
    saveLead({ psid, phone, name: s.name || '', interest: s.interest || 'general', hsc: s.hsc || '', mode: s.mode || '', lastMessage: t });
    const reply = `ধন্যবাদ! আপনার নম্বর ${phone} পেয়েছি ✅\nআপনার সিটটি ধরে রাখা হলো। কাউন্সেলর শীঘ্রই কল করবে।`;
    pushHistory(s, 'assistant', reply);
    return reply;
  }

  // 2. Waiting for a phone number
  if (s.stage === 'awaiting_phone') {
    const reply = `নম্বরটা ঠিকমতো পাইনি — 11 ডিজিটের মোবাইল নম্বর লিখুন, যেমন 01XXXXXXXXX।`;
    pushHistory(s, 'assistant', reply);
    return reply;
  }

  // 3. AI-first (key thakle): manusher moto jobab
  if (AI_ON) {
    try {
      const ai = await askAI(s, t);
      if (ai) {
        if (/নম্বর|ফোন|number/i.test(ai)) s.stage = 'awaiting_phone';
        if (/(ফি|trial|ট্রায়াল|ভিসা|visa)/i.test(t)) s.interest = s.interest || t.slice(0, 40);
        pushHistory(s, 'assistant', ai);
        return ai;
      }
    } catch (e) {
      console.error(`AI failed/slow (${e.message}), rule fallback`);
    }
  }

  // 4. Rule-based fallback — fast, kokhono late na
  const reply = ruleReply(s, t);
  pushHistory(s, 'assistant', reply);
  return reply;
}

// --- send via Graph API (or dry-run log) ---
async function sendTyping(psid) {
  if (DRY_RUN) { console.log(`[DRY-RUN typing -> ${psid}]`); return; }
  try {
    await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/me/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, sender_action: 'typing_on', access_token: PAGE_ACCESS_TOKEN }),
    });
  } catch (e) { console.error('typing error:', e.message); }
}

async function sendMessage(psid, text) {
  logOutbox(psid, text);
  if (DRY_RUN) {
    console.log(`[DRY-RUN -> ${psid}] ${text}`);
    return { dry_run: true, psid, reply: text };
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/me/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: psid }, message: { text }, access_token: PAGE_ACCESS_TOKEN }),
  });
  const data = await res.json();
  if (!res.ok) console.error('Graph API error:', data);
  return data;
}

// Process one incoming message: typing on, reply, send. Webhook already 200-ed.
async function processIncoming(psid, text) {
  const started = Date.now();
  await sendTyping(psid);
  const reply = await handleMessage(psid, text);
  await sendMessage(psid, reply);
  console.log(`reply to ${psid} in ${Date.now() - started}ms (ai=${AI_ON})`);
}

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const body = await new Promise(resolve => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d));
  });
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'GET' && url.pathname === '/webhook') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === VERIFY_TOKEN) { res.writeHead(200); res.end(challenge); return; }
    res.writeHead(403); res.end('Forbidden'); return;
  }

  if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true, version: 'v2-ai-first', ai: AI_ON, model: AI_ON ? AI_MODEL : null, dry_run: DRY_RUN, leads: loadLeads().length });

  if (req.method === 'GET' && url.pathname === '/leads') return json(200, { leads: loadLeads() });

  if (req.method === 'POST' && url.pathname === '/test') {
    try {
      const started = Date.now();
      const { psid = 'test-user', text = '' } = JSON.parse(body || '{}');
      await sendTyping(psid);
      const reply = await handleMessage(psid, text);
      await sendMessage(psid, reply);
      return json(200, { psid, reply, ms: Date.now() - started, ai: AI_ON });
    } catch (e) { return json(400, { error: e.message }); }
  }

  // Real Messenger webhook — INSTANT: 200 OK age, reply pore background-e
  if (req.method === 'POST' && url.pathname === '/webhook') {
    json(200, { status: 'ok' });
    try {
      const data = JSON.parse(body || '{}');
      if (data.object === 'page') {
        for (const entry of data.entry || []) {
          for (const ev of entry.messaging || []) {
            const psid = ev.sender?.id;
            const text = ev.message?.text;
            if (psid && text) processIncoming(psid, text).catch(e => console.error(e));
          }
        }
      }
    } catch (e) { console.error(e); }
    return;
  }

  res.writeHead(404); res.end('Not found. Use GET /health, POST /test, POST /webhook.');
});

server.listen(PORT, () => {
  console.log(`JLI chatbot v2 running on port ${PORT} — ai=${AI_ON} model=${AI_MODEL} dry_run=${DRY_RUN}`);
  if (!AI_ON) console.log('NOTE: OPENAI_API_KEY nei — rule-based menu cholbe (manusher moto hobe na). Key bosale AI-first hobe.');
});
