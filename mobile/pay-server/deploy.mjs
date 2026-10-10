// Triển khai máy chủ thanh toán lên Cloudflare Workers — chạy trong GitHub Actions (.github/workflows/pay.yml), không cần cài gì thêm.
//   node deploy.mjs
// Biến môi trường (GitHub → Settings → Secrets and variables → Actions):
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   bắt buộc — tài khoản Cloudflare miễn phí của chủ app
//   PAY_SIGN_KEY                                  khóa ký mã kích hoạt tự động (tệp PAY_SIGN_KEY.txt trong gói bảo mật)
//   SEPAY_SECRET  (hoặc SEPAY_APIKEY)             khóa xác thực webhook do SePay cấp
// Việc làm: tạo kho đơn (KV) nếu chưa có → tải máy chủ lên kèm khóa bí mật và bảng giá (lấy từ ../store-config.json)
//   → bật địa chỉ <tên>.<tên miền phụ>.workers.dev (tạo tên miền phụ nếu tài khoản chưa có) → kiểm tra /pay/health.
// Kết quả in thành chú thích (annotation) của GitHub Actions: địa chỉ máy chủ, địa chỉ webhook dán vào SePay.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const E = process.env;
const API = (E.CF_API || 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
const NAME = E.WORKER_NAME || 'ngoisao-pay', KV_TITLE = E.KV_TITLE || 'ngoisao-pay-orders';
const note = (t, m) => console.log('::notice title=' + t + '::' + m);
const warn = (t, m) => console.log('::warning title=' + t + '::' + m);
const fail = (t, m) => { console.log('::error title=' + t + '::' + m); process.exit(1); };
const summary = s => { if (E.GITHUB_STEP_SUMMARY) fs.appendFileSync(E.GITHUB_STEP_SUMMARY, s + '\n'); };

if (!E.CLOUDFLARE_API_TOKEN || !E.CLOUDFLARE_ACCOUNT_ID) { note('Chưa triển khai', 'Chưa có CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID trong GitHub Secrets — bỏ qua (app vẫn dùng cách nhập mã thủ công).'); process.exit(0); }
const ACC = E.CLOUDFLARE_ACCOUNT_ID.trim();
const cf = async (method, p, body, headers) => {
  const r = await fetch(API + p, { method, headers: Object.assign({ Authorization: 'Bearer ' + E.CLOUDFLARE_API_TOKEN.trim() }, headers || (body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {})), body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, ok: !!(j && j.success), j: j, err: j && j.errors && j.errors.length ? j.errors.map(x => (x.code ? x.code + ': ' : '') + x.message).join('; ') : 'HTTP ' + r.status };
};

// ---------- khóa ký: phải khớp khóa công khai đã gắn trong app ----------
const pub = JSON.parse(fs.readFileSync(path.join(HERE, 'pub-key.json'), 'utf8'));
let sign = '';
if (E.PAY_SIGN_KEY) {
  let j;
  // dán cả tệp PAY_SIGN_KEY.txt (có dòng ghi chú) cũng được: lấy khối {…} đầu tiên
  const mj = /\{[^{}]*"kty"[^{}]*\}/.exec(E.PAY_SIGN_KEY);
  try { j = JSON.parse(mj ? mj[0] : E.PAY_SIGN_KEY.trim()); } catch (e) { fail('PAY_SIGN_KEY sai dạng', 'Hãy dán nguyên nội dung tệp PAY_SIGN_KEY.txt (có đoạn bắt đầu bằng {"kty":"EC").'); }
  if (!j.d || j.x !== pub.x || j.y !== pub.y) fail('PAY_SIGN_KEY không khớp', 'Khóa này không khớp khóa công khai trong app — dán lại đúng tệp PAY_SIGN_KEY.txt của gói bảo mật mới nhất.');
  sign = JSON.stringify({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y, d: j.d });
} else warn('Thiếu PAY_SIGN_KEY', 'Máy chủ chưa ký được mã kích hoạt: thêm secret PAY_SIGN_KEY rồi chạy lại.');
const sepay = (E.SEPAY_SECRET || '').trim(), sepayKey = (E.SEPAY_APIKEY || '').trim();
if (!sepay && !sepayKey) warn('Thiếu khóa SePay', 'Chưa có SEPAY_SECRET (hoặc SEPAY_APIKEY): máy chủ sẽ từ chối mọi webhook cho tới khi thêm khóa và chạy lại.');

// ---------- bảng giá: lấy từ store-config.json (cùng nguồn với app) ----------
let prices = { week: 150000, month: 250000, year: 599000 };
try { const sc = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'store-config.json'), 'utf8')); if (sc.prices) Object.keys(prices).forEach(k => { if (+sc.prices[k] > 0) prices[k] = Math.round(+sc.prices[k]); }); } catch (e) { warn('Bảng giá', 'Không đọc được store-config.json — dùng giá mặc định.'); }

// ---------- 1. kho đơn KV ----------
let r = await cf('GET', '/accounts/' + ACC + '/storage/kv/namespaces?per_page=100');
if (!r.ok) fail('Không vào được tài khoản Cloudflare', r.err + ' — kiểm tra CLOUDFLARE_API_TOKEN (mẫu quyền "Edit Cloudflare Workers") và CLOUDFLARE_ACCOUNT_ID.');
let ns = (r.j.result || []).find(x => x.title === KV_TITLE);
if (!ns) {
  r = await cf('POST', '/accounts/' + ACC + '/storage/kv/namespaces', { title: KV_TITLE });
  if (!r.ok) fail('Không tạo được kho đơn (KV)', r.err);
  ns = r.j.result;
  note('Kho đơn', 'Đã tạo kho đơn KV "' + KV_TITLE + '".');
}

// ---------- 2. tải máy chủ lên ----------
const bindings = [{ type: 'kv_namespace', name: 'PAY', namespace_id: ns.id }, { type: 'plain_text', name: 'PRICES', text: JSON.stringify(prices) }];
if (sign) bindings.push({ type: 'secret_text', name: 'PAY_SIGN_KEY', text: sign });
if (sepay) bindings.push({ type: 'secret_text', name: 'SEPAY_SECRET', text: sepay });
else if (sepayKey) bindings.push({ type: 'secret_text', name: 'SEPAY_APIKEY', text: sepayKey });
const fd = new FormData();
fd.append('metadata', new Blob([JSON.stringify({ main_module: 'worker.js', compatibility_date: '2024-09-23', bindings: bindings })], { type: 'application/json' }));
fd.append('worker.js', new Blob([fs.readFileSync(path.join(HERE, 'worker.js'), 'utf8')], { type: 'application/javascript+module' }), 'worker.js');
r = await cf('PUT', '/accounts/' + ACC + '/workers/scripts/' + NAME, fd);
if (!r.ok) fail('Không tải được máy chủ lên', r.err);

// ---------- 3. địa chỉ workers.dev ----------
r = await cf('GET', '/accounts/' + ACC + '/workers/subdomain');
let sub = r.ok && r.j.result && r.j.result.subdomain;
if (!sub) {
  const want = (E.WORKERS_SUBDOMAIN || 'ngoisao-' + Math.random().toString(36).slice(2, 8)).toLowerCase();
  r = await cf('PUT', '/accounts/' + ACC + '/workers/subdomain', { subdomain: want });
  if (!r.ok) fail('Chưa có tên miền workers.dev', r.err + ' — mở dash.cloudflare.com → Workers & Pages một lần để chọn tên miền phụ, rồi chạy lại.');
  sub = (r.j.result && r.j.result.subdomain) || want;
  note('Tên miền phụ', 'Đã tạo tên miền phụ ' + sub + '.workers.dev cho tài khoản.');
}
r = await cf('POST', '/accounts/' + ACC + '/workers/scripts/' + NAME + '/subdomain', { enabled: true, previews_enabled: false });
if (!r.ok) warn('Bật địa chỉ workers.dev', r.err + ' — bật tay: Workers & Pages → ' + NAME + ' → Settings → Domains & Routes → workers.dev.');
const URL0 = (E.PAY_HEALTH_BASE || 'https://' + NAME + '.' + sub + '.workers.dev').replace(/\/$/, '');

// ---------- 4. kiểm tra ----------
let health = null;
for (let i = 0; i < 12 && !health; i++) {
  try { const h = await fetch(URL0 + '/pay/health', { headers: { 'Cache-Control': 'no-cache' } }); if (h.ok) health = await h.json(); } catch (e) { /* tên miền mới cần ít phút */ }
  if (!health) await new Promise(res => setTimeout(res, 5000));
}
note('Địa chỉ máy chủ', URL0);
note('Webhook dán vào SePay', URL0 + '/pay/sepay');
if (health) note('Kiểm tra máy chủ', 'Chạy tốt · ký mã: ' + (health.sign ? 'có' : 'CHƯA') + ' · khóa SePay: ' + (health.sepay || 'CHƯA') + ' · giá: ' + JSON.stringify(health.prices));
else warn('Kiểm tra máy chủ', 'Chưa gọi được ' + URL0 + '/pay/health (tên miền mới có thể cần vài phút). Mở thử địa chỉ này trên trình duyệt sau ít phút.');
summary('### Máy chủ thanh toán tự động\n\n- Địa chỉ máy chủ: `' + URL0 + '`\n- Webhook dán vào SePay (Xác thực: HMAC-SHA256): `' + URL0 + '/pay/sepay`\n- Ký mã: ' + (sign ? 'có' : '**chưa có PAY_SIGN_KEY**') + ' · khóa SePay: ' + (sepay ? 'HMAC' : sepayKey ? 'API Key' : '**chưa có**') + '\n- Bảng giá: ' + JSON.stringify(prices));
