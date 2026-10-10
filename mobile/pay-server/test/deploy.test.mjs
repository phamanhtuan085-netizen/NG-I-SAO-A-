// Kiểm thử deploy.mjs bằng một "Cloudflare API" giả chạy trên máy: tạo KV, tải máy chủ (multipart đúng chuẩn), tạo / bật workers.dev, kiểm tra /pay/health.
// node test/deploy.test.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const pub = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'pub-key.json'), 'utf8'));

const run = async (opt) => {
  const st = { ns: opt.ns ? [{ id: 'kv123', title: 'ngoisao-pay-orders' }] : [], sub: opt.sub || '', upload: null, enabled: false, calls: [] };
  const srv = http.createServer((req, res) => {
    let body = [];
    req.on('data', c => body.push(c));
    req.on('end', () => {
      body = Buffer.concat(body);
      st.calls.push(req.method + ' ' + req.url);
      const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      const u = req.url;
      if (u === '/pay/health') return send(200, { ok: true, sign: true, sepay: 'hmac', prices: { week: 150000, month: 250000, year: 599000 } });
      if (req.headers.authorization !== 'Bearer tok') return send(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
      if (u.startsWith('/client/v4/accounts/acc/storage/kv/namespaces') && req.method === 'GET') return send(200, { success: true, result: st.ns });
      if (u === '/client/v4/accounts/acc/storage/kv/namespaces' && req.method === 'POST') { const t = JSON.parse(body).title; st.ns.push({ id: 'kvNEW', title: t }); return send(200, { success: true, result: { id: 'kvNEW', title: t } }); }
      if (u === '/client/v4/accounts/acc/workers/scripts/ngoisao-pay' && req.method === 'PUT') { st.upload = { type: req.headers['content-type'], body: body.toString('utf8') }; return send(200, { success: true, result: { id: 'ngoisao-pay' } }); }
      if (u === '/client/v4/accounts/acc/workers/subdomain' && req.method === 'GET') return st.sub ? send(200, { success: true, result: { subdomain: st.sub } }) : send(404, { success: false, errors: [{ code: 10007, message: 'workers.dev subdomain not found' }] });
      if (u === '/client/v4/accounts/acc/workers/subdomain' && req.method === 'PUT') { st.sub = JSON.parse(body).subdomain; return send(200, { success: true, result: { subdomain: st.sub } }); }
      if (u === '/client/v4/accounts/acc/workers/scripts/ngoisao-pay/subdomain' && req.method === 'POST') { st.enabled = JSON.parse(body).enabled === true; return send(200, { success: true, result: { enabled: true } }); }
      send(404, { success: false, errors: [{ code: 7003, message: 'no route ' + u }] });
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const env = Object.assign({}, process.env, { CF_API: base + '/client/v4', PAY_HEALTH_BASE: base, CLOUDFLARE_API_TOKEN: opt.token || 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc', PAY_SIGN_KEY: opt.key === undefined ? JSON.stringify({ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, d: 'dddd' }) : opt.key, SEPAY_SECRET: opt.sepay === undefined ? 'spsk_x' : opt.sepay, GITHUB_STEP_SUMMARY: '' });
  if (opt.noCf) { delete env.CLOUDFLARE_API_TOKEN; }
  // chạy bất đồng bộ: máy chủ giả trong cùng tiến trình vẫn trả lời được
  const p = await new Promise(resolve => {
    const cp = spawn(process.execPath, [path.join(HERE, '..', 'deploy.mjs')], { env });
    let out = '';
    cp.stdout.on('data', d => { out += d; }); cp.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => cp.kill('SIGKILL'), 60000);
    cp.on('close', code => { clearTimeout(t); resolve({ stdout: out, stderr: '', status: code }); });
  });
  srv.close();
  return { st, out: p.stdout + p.stderr, code: p.status };
};

// lần đầu: chưa có KV, chưa có tên miền phụ
let r = await run({ ns: false, sub: '' });
ok(r.code === 0, 'triển khai lần đầu thành công\n' + r.out);
ok(r.st.calls.includes('POST /client/v4/accounts/acc/storage/kv/namespaces'), 'chưa có kho đơn → tạo KV');
ok(/multipart\/form-data; boundary=/.test(r.st.upload && r.st.upload.type), 'tải máy chủ bằng multipart/form-data');
const b = r.st.upload ? r.st.upload.body : '';
ok(/name="metadata"[\s\S]*application\/json[\s\S]*"main_module":"worker.js"/.test(b), 'phần metadata: main_module = worker.js');
ok(/name="worker.js"; filename="worker.js"\r?\nContent-Type: application\/javascript\+module/.test(b), 'phần mã: worker.js, kiểu application/javascript+module');
ok(b.includes('"type":"kv_namespace","name":"PAY","namespace_id":"kvNEW"') && b.includes('"name":"PRICES"') && b.includes('"type":"secret_text","name":"PAY_SIGN_KEY"') && b.includes('"type":"secret_text","name":"SEPAY_SECRET","text":"spsk_x"'), 'gắn KV, bảng giá, khóa ký, khóa SePay');
ok(b.includes('\\"year\\":599000'), 'bảng giá lấy từ store-config.json');
ok(b.includes('const handler = {'), 'gửi đúng mã máy chủ');
ok(/^ngoisao-[a-z0-9]{6}$/.test(r.st.sub) && r.st.enabled, 'chưa có tên miền phụ → tự tạo, bật workers.dev cho máy chủ');
ok(/::notice title=Webhook dán vào SePay::http:\/\/127\.0\.0\.1:\d+\/pay\/sepay/.test(r.out) && /Chạy tốt/.test(r.out), 'in địa chỉ webhook và kết quả kiểm tra');

// lần sau: đã có KV và tên miền phụ
r = await run({ ns: true, sub: 'phamanhtuan' });
ok(r.code === 0 && !r.st.calls.includes('POST /client/v4/accounts/acc/storage/kv/namespaces') && r.st.upload.body.includes('"namespace_id":"kv123"'), 'đã có kho đơn → dùng lại, không tạo mới');
ok(!r.st.calls.includes('PUT /client/v4/accounts/acc/workers/subdomain'), 'đã có tên miền phụ → giữ nguyên');

// dán cả tệp PAY_SIGN_KEY.txt (có ghi chú) vẫn nhận
r = await run({ ns: true, sub: 'x', key: 'Khóa ký mã tự động — dán toàn bộ tệp này\n' + JSON.stringify({ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, d: 'dddd' }) + '\n' });
ok(r.code === 0 && r.st.upload.body.includes('"name":"PAY_SIGN_KEY"'), 'dán cả tệp PAY_SIGN_KEY.txt (kèm dòng ghi chú) vẫn nhận đúng khóa');

// thiếu / sai cấu hình
r = await run({ noCf: true });
ok(r.code === 0 && /Chưa triển khai/.test(r.out) && r.st.calls.length === 0, 'chưa có khóa Cloudflare → bỏ qua, không báo lỗi');
r = await run({ token: 'sai' });
ok(r.code === 1 && /::error title=Không vào được tài khoản Cloudflare::10000: Authentication error/.test(r.out), 'khóa Cloudflare sai → báo lỗi rõ ràng');
r = await run({ key: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'khac', y: pub.y, d: 'dd' }) });
ok(r.code === 1 && /PAY_SIGN_KEY không khớp/.test(r.out) && r.st.calls.length === 0, 'dán nhầm khóa ký → dừng trước khi tải lên');
r = await run({ key: '', sepay: '' });
ok(r.code === 0 && /Thiếu PAY_SIGN_KEY/.test(r.out) && /Thiếu khóa SePay/.test(r.out) && !r.st.upload.body.includes('secret_text'), 'chưa có khóa ký / khóa SePay → vẫn triển khai, nhắc thêm khóa');

console.log('Triển khai máy chủ:', n, 'kiểm tra,', fails, 'lỗi');
process.exit(fails ? 1 : 0);
