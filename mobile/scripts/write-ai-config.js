// Ghi www/ai-config.js từ biến môi trường (dùng trong GitHub Actions khi có Secrets HVNS_AI_ENDPOINT, HVNS_AI_APP_KEY)
const fs = require('fs');
const path = require('path');
const endpoint = String(process.env.HVNS_AI_ENDPOINT || '').trim();
const key = String(process.env.HVNS_AI_APP_KEY || '').trim();
if (endpoint && !/^https:\/\//.test(endpoint)) { console.error('HVNS_AI_ENDPOINT phải bắt đầu bằng https://'); process.exit(1); }
const file = path.join(__dirname, '..', 'www', 'ai-config.js');
const head = fs.existsSync(file) ? (fs.readFileSync(file, 'utf8').match(/^\/\*[\s\S]*?\*\/\n/) || [''])[0] : '';
fs.writeFileSync(file, head + 'window.HVNS_CONFIG = ' + JSON.stringify({ aiEndpoint: endpoint, aiKey: key }) + ';\n');
console.log('Gia sư AI:', endpoint ? 'đã cấu hình ' + endpoint : 'chưa cấu hình (bản không có AI)');
