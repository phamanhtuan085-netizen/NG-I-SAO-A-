// Kiểm thử máy chủ thanh toán tự động: webhook SePay (HMAC / API Key), sổ đơn, đối chiếu số tiền, ký mã kích hoạt, cộng dồn hạn, sổ đơn của chủ app.
// node test/worker.test.mjs
import worker from '../worker.js';
const W = worker._;
const S = crypto.subtle, enc = new TextEncoder();
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };

// KV giả (giống API Cloudflare: get(key,'json'), put(key, value, {metadata}), list({prefix, cursor}))
const kv = () => {
  const m = new Map();
  return {
    m, writes: 0,
    async get(k, t) { const v = m.has(k) ? m.get(k).v : null; if (v == null) return null; return (t === 'json' || (t && t.type === 'json')) ? JSON.parse(v) : v; },
    async put(k, v, o) { this.writes++; m.set(k, { v: String(v), meta: o && o.metadata }); },
    async list(o) { const keys = [...m.keys()].filter(k => k.startsWith(o.prefix || '')).sort().map(k => ({ name: k, metadata: m.get(k).meta })); return { keys, list_complete: true }; }
  };
};
const b64u = u8 => Buffer.from(u8).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const kp = await S.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await S.exportKey('jwk', kp.privateKey);
const SIGN = JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d });
const SECRET = 'spsk_test_' + Math.random().toString(36).slice(2);
const env = { PAY: kv(), PAY_SIGN_KEY: SIGN, SEPAY_SECRET: SECRET, PRICES: '{"week":150000,"month":250000,"year":599000}' };
const BASE = 'https://ngoisao-pay.example.workers.dev';
const hmac = async (key, msg) => Buffer.from(await S.sign('HMAC', await S.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), enc.encode(msg))).toString('hex');
let txid = 1000;
const hook = async (body, o) => {
  o = o || {};
  const raw = JSON.stringify(Object.assign({ id: ++txid, gateway: 'BIDV', transactionDate: '2026-10-10 08:00:00', accountNumber: '2890889999', subAccount: '96247NSA01', code: null, content: '', transferType: 'in', description: '', transferAmount: 0, accumulated: 0, referenceCode: 'FT' + txid }, body));
  const ts = String(o.ts || Math.floor(Date.now() / 1000));
  const h = { 'Content-Type': 'application/json' };
  if (!o.noauth) { h['X-SePay-Timestamp'] = ts; h['X-SePay-Signature'] = 'sha256=' + await hmac(o.key || SECRET, ts + '.' + raw); }
  if (o.apikey) h.Authorization = 'Apikey ' + o.apikey;
  const r = await worker.fetch(new Request(BASE + '/pay/sepay', { method: 'POST', headers: h, body: raw }), o.env || env);
  return { status: r.status, body: await r.text() };
};
const poll = async (code, q, e) => { const r = await worker.fetch(new Request(BASE + '/pay/order/' + code + (q || '')), e || env); return Object.assign({ status: r.status }, await r.json()); };
const pubKey = await S.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const EPOCH = Date.UTC(2024, 0, 1), DAY = 86400000, VN = 7 * 3600000;
const today = Math.floor((Date.now() + VN - EPOCH) / DAY);
const readNsa = async code => {
  const m = /^NSA1\.([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{86})$/.exec(code);
  if (!m) return null;
  const p = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const good = await S.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64'), enc.encode('NSA1.' + m[1]));
  return { good, kind: p[0], plan: p[1], day: p[2] * 256 + p[3], serial: p.readUInt32BE(4) };
};

// ---------- tìm mã đơn trong nội dung ngân hàng ----------
ok(W.findCode({ code: 'NSAK7Q2MXAB' }) === 'NSAK7Q2MXAB', 'mã do SePay tách sẵn');
ok(W.findCode({ code: null, content: 'MBVCB.1234567890.NSAK7Q2MXAB.CT tu 0123 NGUYEN VAN A toi 2890889999' }) === 'NSAK7Q2MXAB', 'mã giữa nội dung ngân hàng (dấu chấm)');
ok(W.findCode({ content: 'nsa k7q2mxab' }) === 'NSAK7Q2MXAB', 'chữ thường, có dấu cách sau NSA');
ok(W.findCode({ content: 'IBFT NSAK7Q2MXABCT TU' }) === 'NSAK7Q2MXAB', 'dính chữ phía sau vẫn lấy đúng 8 ký tự');
ok(W.findCode({ content: 'chuyen tien an trua' }) === '', 'không có mã đơn');
ok(W.planFor(599000, W.prices(env)) === 'year' && W.planFor(300000, W.prices(env)) === 'month' && W.planFor(150000, W.prices(env)) === 'week' && W.planFor(149000, W.prices(env)) === '', 'số tiền → gói');
ok(W.prices({ PRICES: '{"year":699000}' }).year === 699000 && W.prices({}).month === 250000, 'bảng giá đọc từ cấu hình, thiếu thì dùng giá mặc định');

// ---------- webhook: xác thực ----------
let r = await hook({ content: 'NSAAAAAAAAA', transferAmount: 250000 }, { key: 'sai-khoa' });
ok(r.status === 401, 'chữ ký HMAC sai → 401');
r = await hook({ content: 'NSAAAAAAAAA', transferAmount: 250000 }, { ts: Math.floor(Date.now() / 1000) - 900 });
ok(r.status === 401, 'webhook quá 5 phút (gửi lại để lừa) → 401');
r = await hook({ content: 'NSAAAAAAAAA', transferAmount: 250000 }, { noauth: true });
ok(r.status === 401, 'không có chữ ký → 401');
ok(env.PAY.m.size === 0, 'webhook bị từ chối không ghi gì vào sổ');

// ---------- đủ tiền gói Tháng ----------
const C1 = 'NSAK7Q2MXAB';
r = await hook({ content: 'MBVCB.99.' + C1 + '.CT tu 0123', transferAmount: 250000 });
ok(r.status === 200 && r.body === '{"success": true}', 'nhận webhook: trả đúng {"success": true} (SePay đòi đúng như vậy)');
let p = await poll(C1);
ok(p.st === 'ok' && p.plan === 'month' && /^NSA1\./.test(p.code), 'app hỏi đơn → nhận mã kích hoạt gói Tháng');
let c = await readNsa(p.code);
ok(c && c.good && c.kind === 1 && c.plan === 2 && c.day === today + 30 && c.serial >= 0x80000000, 'mã ký đúng khóa, gói Tháng, hạn hôm nay + 30 ngày, sê-ri tự động');
ok(p.until === EPOCH + (today + 31) * DAY - VN - 1, 'hạn dùng tới hết ngày theo giờ Việt Nam');
const again = await poll(C1);
ok(again.code === p.code, 'hỏi lại: trả đúng mã cũ, không tạo mã mới');
// SePay gửi lại cùng giao dịch (cùng id)
const rec0 = JSON.parse(env.PAY.m.get('c:' + C1).v);
const raw = JSON.stringify({ id: rec0.txs[0].id, transferType: 'in', transferAmount: 250000, content: C1 });
const ts = String(Math.floor(Date.now() / 1000));
const rr = await worker.fetch(new Request(BASE + '/pay/sepay', { method: 'POST', headers: { 'X-SePay-Timestamp': ts, 'X-SePay-Signature': 'sha256=' + await hmac(SECRET, ts + '.' + raw) }, body: raw }), env);
ok(rr.status === 200 && JSON.parse(env.PAY.m.get('c:' + C1).v).amt === 250000, 'SePay gửi lại cùng giao dịch: không cộng tiền hai lần');

// ---------- chưa đủ tiền, chuyển thêm ----------
const C2 = 'NSAPQRSTUV2';
await hook({ content: C2, transferAmount: 100000 });
p = await poll(C2);
ok(p.st === 'short' && p.got === 100000 && p.need === 150000, 'chuyển thiếu (100.000đ) → báo chưa đủ, chưa mở gói');
await hook({ content: C2, transferAmount: 50000 });
p = await poll(C2);
ok(p.st === 'ok' && p.plan === 'week', 'chuyển thêm cho đủ 150.000đ → mở gói Tuần');

// ---------- chưa có tiền ----------
p = await poll('NSAZZZZZZZ9');
ok(p.st === 'wait', 'chưa có tiền về → chờ');
p = await poll('ABC');
ok(p.status === 400, 'mã đơn sai dạng → 400');

// ---------- cộng dồn hạn ----------
const C3 = 'NSAYEAR0001';
await hook({ content: C3, transferAmount: 599000 });
p = await poll(C3, '?prev=' + encodeURIComponent(again.code));
c = await readNsa(p.code);
ok(c.plan === 3 && c.day === today + 30 + 365, 'đang còn gói Tháng mua thêm gói Năm → cộng dồn: hạn = hết gói cũ + 365 ngày');
// mã giả mạo không được cộng dồn
const fake = again.code.slice(0, -4) + (again.code.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
const C4 = 'NSAFAKEPREV1';
await hook({ content: 'NSAFAKEPREV', transferAmount: 250000 });
p = await poll('NSAFAKEPREV', '?prev=' + encodeURIComponent(fake));
c = await readNsa(p.code);
ok(c.day === today + 30, 'mã cũ có chữ ký sai → không cộng dồn (tính từ hôm nay)');
// còn Gói Năm mà mua thêm Gói Tuần: cộng dồn, giữ tên Gói Năm
const yearCode = (await poll(C3)).code;
await hook({ content: 'NSAWEEKADD1', transferAmount: 150000 });
p = await poll('NSAWEEKADD1', '?prev=' + encodeURIComponent(yearCode));
c = await readNsa(p.code);
ok(c.plan === 3 && c.day === today + 30 + 365 + 7, 'còn Gói Năm mua thêm Gói Tuần → cộng 7 ngày, vẫn ghi Gói Năm');
// mã dùng thử (phiên bản 2) ký bằng khóa của máy chủ: cộng sau ngày hết dùng thử (giới hạn bởi số ngày dùng thử)
const tb = new Uint8Array([2, 30, ((today + 60) >> 8) & 255, (today + 60) & 255, 0, 0, 0, 7]);
const tmsg = 'NSA1.' + b64u(tb);
const tcode = tmsg + '.' + b64u(new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, enc.encode(tmsg))));
await hook({ content: 'NSATRIAL001', transferAmount: 250000 });
p = await poll('NSATRIAL001', '?prev=' + encodeURIComponent(tcode) + '&te=' + (Date.now() + 10 * DAY));
c = await readNsa(p.code);
ok(c.day === today + 10 + 30, 'đang dùng thử còn 10 ngày, mua gói Tháng → hạn = hết dùng thử + 30 ngày');
await hook({ content: 'NSATRIAL002', transferAmount: 250000 });
p = await poll('NSATRIAL002', '?prev=' + encodeURIComponent(tcode) + '&te=' + (Date.now() + 400 * DAY));
c = await readNsa(p.code);
ok(c.day === today + 30 + 30, 'khai hạn dùng thử quá dài → chỉ tính tối đa số ngày dùng thử của mã');

// ---------- tiền vào không có mã đơn, giao dịch tiền ra ----------
r = await hook({ content: 'CHUYEN TIEN MUA GOI', transferAmount: 250000 });
ok(r.status === 200 && [...env.PAY.m.keys()].some(k => /^c:_\d+$/.test(k)), 'tiền vào không có mã đơn → ghi sổ "không có mã" để chủ app xử lý');
const before = env.PAY.m.size;
r = await hook({ content: 'NSAOUT00001', transferType: 'out', transferAmount: 250000 });
ok(r.status === 200 && env.PAY.m.size === before, 'giao dịch tiền ra → bỏ qua');

// ---------- chủ app xem sổ đơn ----------
const okey = await W.ownerKey(env);
let lr = await worker.fetch(new Request(BASE + '/pay/orders', { headers: { 'X-Owner-Key': 'sai' } }), env);
ok(lr.status === 401, 'sổ đơn: sai khóa chủ app → 401');
lr = await worker.fetch(new Request(BASE + '/pay/orders', { headers: { 'X-Owner-Key': okey } }), env);
const lj = await lr.json();
ok(lr.status === 200 && lj.orders.length >= 6 && lj.orders.some(o => o.code === C1 && o.p === 'month' && o.s === 'paid' && o.n === again.code) && lj.orders.some(o => o.s === 'nocode' && /CHUYEN TIEN/.test(o.x)), 'sổ đơn của chủ app: có đơn đã mở gói (kèm mã), đơn không có mã');
ok(okey.length === 32, 'khóa chủ app 32 ký tự');

// ---------- kiểu xác thực API Key ----------
const env2 = { PAY: kv(), PAY_SIGN_KEY: SIGN, SEPAY_APIKEY: 'ak_test_123' };
r = await hook({ content: 'NSAAPIKEY01', transferAmount: 150000 }, { noauth: true, apikey: 'ak_test_123', env: env2 });
ok(r.status === 200 && (await poll('NSAAPIKEY01', '', env2)).st === 'ok', 'kiểu API Key: đúng khóa → nhận');
r = await hook({ content: 'NSAAPIKEY02', transferAmount: 150000 }, { noauth: true, apikey: 'sai', env: env2 });
ok(r.status === 401, 'kiểu API Key: sai khóa → 401');
// chưa cấu hình gì
const env3 = { PAY: kv() };
r = await hook({ content: 'NSAAPIKEY03', transferAmount: 150000 }, { env: env3 });
ok(r.status === 401, 'chưa đặt khóa webhook → từ chối mọi webhook');
const h = await (await worker.fetch(new Request(BASE + '/pay/health'), env)).json();
ok(h.ok && h.kv && h.sign && h.sepay === 'hmac' && h.prices.year === 599000, 'kiểm tra cấu hình /pay/health');
const opt = await worker.fetch(new Request(BASE + '/pay/order/' + C1, { method: 'OPTIONS' }), env);
ok(opt.status === 204 && opt.headers.get('Access-Control-Allow-Origin') === '*', 'CORS cho app (web, APK)');
ok(env.PAY.writes <= 30, 'số lần ghi KV vừa phải (' + env.PAY.writes + ')');

console.log('Máy chủ thanh toán:', n, 'kiểm tra,', fails, 'lỗi');
process.exit(fails ? 1 : 0);
