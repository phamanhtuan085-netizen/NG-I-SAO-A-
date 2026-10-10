/* Máy chủ thanh toán tự động — Ngôi Sao A+ (Cloudflare Workers, gói miễn phí là đủ).
 *
 * Khách chuyển khoản tới tài khoản của chủ app (tài khoản ảo BIDV nối với SePay) với nội dung NSA + 8 ký tự = MÃ ĐƠN do app tạo.
 *   1. SePay thấy tiền vào → gửi webhook tới POST /pay/sepay → máy chủ ghi đơn, đối chiếu số tiền với bảng giá → gói.
 *   2. App đang chờ (hoặc lần mở sau) hỏi GET /pay/order/<MÃ ĐƠN> → máy chủ ký MÃ KÍCH HOẠT NSA1 (giống hệt mã chủ app tạo tay,
 *      ký bằng khóa riêng của máy chủ) → app tự mở gói. Còn hạn gói cũ thì cộng dồn.
 * Tiền về thẳng tài khoản ngân hàng của chủ app: SePay và máy chủ này chỉ đọc thông báo giao dịch, không giữ tiền.
 * Máy chủ không lưu tên, số điện thoại hay tài khoản của khách — chỉ mã đơn, số tiền, thời gian, mã giao dịch ngân hàng.
 *
 * Cấu hình (GitHub Actions → deploy.mjs tự đặt):
 *   PAY            KV namespace — sổ đơn
 *   PAY_SIGN_KEY   khóa ký riêng P-256 dạng JWK có "d" (bí mật) — khóa công khai tương ứng nằm trong app
 *   SEPAY_SECRET   khóa bí mật xác thực webhook HMAC-SHA256 của SePay (khuyên dùng)  — hoặc SEPAY_APIKEY (kiểu API Key)
 *   PRICES         bảng giá đồng: {"week":150000,"month":250000,"year":599000} (lấy từ mobile/store-config.json)
 * Đường dẫn:
 *   POST /pay/sepay                     webhook SePay (trả đúng {"success": true} khi nhận xong)
 *   GET  /pay/order/NSAxxxxxxxx         app hỏi đơn; ?prev=<mã kích hoạt đang dùng>&te=<hết dùng thử, ms> để cộng dồn hạn
 *                                       → {st:'wait'} | {st:'short', got, need} | {st:'ok', code, plan, until}
 *   GET  /pay/orders                    chủ app xem 100 đơn gần nhất (header X-Owner-Key — Khu vực chủ app tự gửi)
 *   GET  /pay/health                    kiểm tra cấu hình
 */
const MAIN_PUB = { kty: 'EC', crv: 'P-256', x: 'fAVzO9PcCMY1VumimOLTirGd9PYgu0aH1BGxvvZYc-0', y: 'RT9m8Ysk6PRYRP34xVnhHydI_y-DcMYRLppxiN41nJo' };
const EPOCH = Date.UTC(2024, 0, 1), DAY = 86400000, VN = 7 * 3600000;
const PLANS = { week: { c: 1, days: 7 }, month: { c: 2, days: 30 }, year: { c: 3, days: 365 } };
const DEFAULT_PRICES = { week: 150000, month: 250000, year: 599000 };
const CODE_RE = /^NSA[A-Z0-9]{8}$/;
const OK_BODY = '{"success": true}';
const enc = new TextEncoder();

const b64u = u8 => { let s = ''; u8.forEach(b => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
const safeEq = (a, b) => { a = String(a || ''); b = String(b || ''); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0 && a.length > 0; };
const today = () => Math.floor((Date.now() + VN - EPOCH) / DAY);
const dayOfMs = ms => Math.floor((+ms + VN - EPOCH) / DAY);
const dayEnd = d => EPOCH + (d + 1) * DAY - VN - 1;

const prices = env => {
  let p = null;
  try { p = typeof env.PRICES === 'string' ? JSON.parse(env.PRICES) : env.PRICES; } catch (e) { p = null; }
  const out = {};
  Object.keys(PLANS).forEach(k => { const v = p && Math.round(+p[k]); out[k] = v > 0 ? v : DEFAULT_PRICES[k]; });
  return out;
};
// số tiền → gói lớn nhất mà khách đã trả đủ
const planFor = (amt, pr) => Object.keys(PLANS).sort((a, b) => pr[b] - pr[a]).find(k => amt >= pr[k]) || '';
// mã đơn trong nội dung chuyển khoản (ngân hàng có thể chèn thêm chữ trước / sau, bỏ dấu cách)
const findCode = b => {
  const c = String((b && b.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^NSA[A-Z0-9]{8}/.test(c)) return c.slice(0, 11);
  for (const s of [b && b.content, b && b.description]) {
    if (typeof s !== 'string') continue;
    const u = s.toUpperCase();
    const m = /NSA[ ._-]?([A-Z0-9]{8})(?![A-Z0-9])/.exec(u) || /NSA([A-Z0-9]{8})/.exec(u.replace(/[^A-Z0-9]/g, ''));
    if (m) return 'NSA' + m[1];
  }
  return '';
};

// ---------- khóa ký ----------
let SIGN = null, SIGN_SRC = '', OWN_PUB = null, PUBKEYS = null;
const signKey = async env => {
  if (!env.PAY_SIGN_KEY) return null;
  if (SIGN && SIGN_SRC === env.PAY_SIGN_KEY) return SIGN;
  const j = JSON.parse(env.PAY_SIGN_KEY);
  SIGN = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: j.x, y: j.y, d: j.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  SIGN_SRC = env.PAY_SIGN_KEY; OWN_PUB = { kty: 'EC', crv: 'P-256', x: j.x, y: j.y }; PUBKEYS = null;
  return SIGN;
};
const verifyKeys = async () => {
  if (PUBKEYS) return PUBKEYS;
  const list = [MAIN_PUB].concat(OWN_PUB ? [OWN_PUB] : []);
  PUBKEYS = await Promise.all(list.map(j => crypto.subtle.importKey('jwk', j, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])));
  return PUBKEYS;
};
// mã kích hoạt đang dùng (để cộng dồn hạn): phải có chữ ký đúng của chủ app hoặc của máy chủ này
const readCode = async raw => {
  const m = /NSA1\.([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{86})/.exec(String(raw || ''));
  if (!m) return null;
  const p = unb64u(m[1]);
  if (p.length !== 8) return null;
  const msg = enc.encode('NSA1.' + m[1]), sig = unb64u(m[2]);
  let good = false;
  for (const k of await verifyKeys()) { if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, sig, msg)) { good = true; break; } }
  if (!good) return null;
  return { kind: p[0], b1: p[1], day: p[2] * 256 + p[3] };
};
const mint = async (env, plan, prev, te) => {
  const key = await signKey(env);
  if (!key || !PLANS[plan]) return null;
  const t = today();
  let base = t;
  const p = prev ? await readCode(prev) : null;
  let pc = PLANS[plan].c;
  // gói cũ còn hạn (không tính mã chủ app hạn tới 2099): cộng tiếp từ ngày hết hạn, giữ tên gói lớn hơn
  if (p && p.kind === 1 && p.day >= t && p.day <= t + 2000) { base = p.day; pc = Math.max(pc, p.b1 >= 1 && p.b1 <= 3 ? p.b1 : 0); }
  else if (p && p.kind === 2 && +te > 0) base = Math.max(t, Math.min(dayOfMs(te), t + p.b1)); // đang dùng thử: cộng sau ngày hết dùng thử
  const ud = Math.min(base + PLANS[plan].days, t + 2400);
  const serial = (crypto.getRandomValues(new Uint32Array(1))[0] | 0x80000000) >>> 0; // bit cao = mã do máy chủ tự động tạo
  const b = new Uint8Array([1, pc, (ud >> 8) & 255, ud & 255, (serial >>> 24) & 255, (serial >>> 16) & 255, (serial >>> 8) & 255, serial & 255]);
  const msg = 'NSA1.' + b64u(b);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(msg)));
  return { code: msg + '.' + b64u(sig), until: dayEnd(ud), serial: serial };
};
const ownerKey = async env => {
  if (!env.PAY_SIGN_KEY) return '';
  const d = JSON.parse(env.PAY_SIGN_KEY).d;
  const k = await crypto.subtle.importKey('raw', enc.encode(d), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode('ngoisao-owner-orders')))).slice(0, 32);
};

// ---------- xác thực webhook SePay ----------
const authSepay = async (req, env, raw) => {
  if (env.SEPAY_SECRET) {
    const ts = req.headers.get('X-SePay-Timestamp') || '', sig = req.headers.get('X-SePay-Signature') || '';
    if (!/^\d{9,11}$/.test(ts) || Math.abs(Date.now() / 1000 - +ts) > 300) return false;
    const k = await crypto.subtle.importKey('raw', enc.encode(env.SEPAY_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return safeEq(sig, 'sha256=' + hex(await crypto.subtle.sign('HMAC', k, enc.encode(ts + '.' + raw))));
  }
  if (env.SEPAY_APIKEY) return safeEq(req.headers.get('Authorization'), 'Apikey ' + env.SEPAY_APIKEY);
  return false;
};

// ---------- sổ đơn (KV: c:<mã đơn>, metadata tóm tắt để chủ app xem nhanh) ----------
const meta = r => ({ t: r.t, a: r.amt, p: r.plan || '', s: r.st, n: r.nsa || '', u: r.until || 0, x: r.st === 'nocode' ? String(r.memo || '').slice(0, 60) : '' });
const putRec = (env, r) => env.PAY.put('c:' + r.code, JSON.stringify(r), { metadata: meta(r), expirationTtl: 60 * 60 * 24 * 400 });
const getRec = async (env, code) => { const v = await env.PAY.get('c:' + code, 'json'); return v && typeof v === 'object' ? v : null; };

const handler = {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/';
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Owner-Key', 'Access-Control-Max-Age': '86400' };
    const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors) });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const pr = prices(env);

    if (req.method === 'GET' && (path === '/' || path === '/pay/health')) {
      return json({ ok: true, service: 'ngoisao-pay', kv: !!env.PAY, sign: !!env.PAY_SIGN_KEY, sepay: env.SEPAY_SECRET ? 'hmac' : env.SEPAY_APIKEY ? 'apikey' : '', prices: pr });
    }
    if (!env.PAY) return json({ error: 'not_configured' }, 503);

    // ----- SePay báo có giao dịch -----
    if (req.method === 'POST' && path === '/pay/sepay') {
      const raw = await req.text();
      if (!(await authSepay(req, env, raw))) return json({ success: false, error: 'unauthorized' }, 401);
      let b;
      try { b = JSON.parse(raw); } catch (e) { return json({ success: false, error: 'bad_json' }, 400); }
      const ok = () => new Response(OK_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
      const amt = Math.round(+b.transferAmount) || 0, id = String(b.id == null ? '' : b.id).slice(0, 40);
      if (b.transferType !== 'in' || amt <= 0 || !id) return ok();
      const tx = { id: id, a: amt, at: String(b.transactionDate || '').slice(0, 25), ref: String(b.referenceCode || '').slice(0, 40), acc: String(b.subAccount || b.accountNumber || '').slice(0, 30) };
      const code = findCode(b);
      if (!code) {
        // tiền vào không có mã đơn (chuyển khoản tay, khách gõ sai nội dung…): ghi lại để chủ app xử lý
        const r0 = await getRec(env, '_' + id);
        if (!r0) await putRec(env, { code: '_' + id, t: Date.now(), amt: amt, txs: [tx], plan: '', st: 'nocode', memo: String(b.content || '') });
        return ok();
      }
      const r = (await getRec(env, code)) || { code: code, t: Date.now(), amt: 0, txs: [], plan: '', st: 'short' };
      if (r.txs.some(x => x.id === id)) return ok(); // SePay gửi lại cùng giao dịch
      r.txs.push(tx); r.amt += amt;
      if (r.nsa) r.more = true; // đã mở gói rồi mà còn tiền vào thêm: chủ app xem trong sổ đơn
      else { r.plan = planFor(r.amt, pr); r.st = r.plan ? 'paid' : 'short'; }
      await putRec(env, r);
      return ok();
    }

    // ----- app hỏi đơn -----
    const m = /^\/pay\/order\/([A-Za-z0-9]+)$/.exec(path);
    if (req.method === 'GET' && m) {
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: 'bad_code' }, 400);
      const r = await getRec(env, code);
      if (!r) return json({ st: 'wait' });
      if (!r.nsa && r.st !== 'paid') return json({ st: 'short', got: r.amt, need: Math.min.apply(null, Object.keys(pr).map(k => pr[k])) });
      if (!r.nsa) {
        const c = await mint(env, r.plan, String(url.searchParams.get('prev') || '').slice(0, 200), url.searchParams.get('te'));
        if (!c) return json({ error: 'not_configured' }, 503);
        Object.assign(r, { nsa: c.code, until: c.until, serial: c.serial, mt: Date.now() });
        await putRec(env, r);
      }
      return json({ st: 'ok', code: r.nsa, plan: r.plan, until: r.until, amt: r.amt });
    }

    // ----- chủ app xem sổ đơn -----
    if (req.method === 'GET' && path === '/pay/orders') {
      const want = await ownerKey(env);
      if (!want || !safeEq(req.headers.get('X-Owner-Key'), want)) return json({ error: 'unauthorized' }, 401);
      const out = [];
      let cursor;
      for (let i = 0; i < 10; i++) {
        const l = await env.PAY.list({ prefix: 'c:', cursor: cursor });
        l.keys.forEach(k => out.push(Object.assign({ code: k.name.slice(2) }, k.metadata || {})));
        if (l.list_complete || !l.cursor) break;
        cursor = l.cursor;
      }
      out.sort((a, b) => (b.t || 0) - (a.t || 0));
      return json({ ok: true, orders: out.slice(0, 100), total: out.length });
    }
    return json({ error: 'not_found' }, 404);
  }
};
// dùng cho kiểm thử (không liệt kê được, máy chủ Workers bỏ qua)
Object.defineProperty(handler, '_', { value: { prices, planFor, findCode, readCode, mint, ownerKey, authSepay } });
export default handler;
