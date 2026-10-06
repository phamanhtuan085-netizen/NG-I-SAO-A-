# Học viện Ngôi Sao — dự án ứng dụng Android & iOS

Ứng dụng luyện Toán, Tiếng Anh, Tư duy cho học sinh mầm non đến lớp 9. Giao diện là web (HTML/JS, chạy ngoại tuyến), được
đóng gói thành ứng dụng gốc bằng **Capacitor 8**. Tài liệu này dành cho người đóng gói / kỹ thuật viên; hướng dẫn từng bước cho
chủ ứng dụng nằm ở tệp `HUONG-DAN-DUA-LEN-CUA-HANG.pdf` ở thư mục gốc của gói.

## Thông số

| Mục | Giá trị |
|---|---|
| Mã ứng dụng | `vn.hocviengoisao.app` (Android `applicationId`/`namespace`, iOS Bundle ID) |
| Phiên bản | 1.0.0 — Android `versionName` trong `android/app/build.gradle`, iOS `MARKETING_VERSION` trong dự án Xcode |
| Số bản dựng | Android `versionCode` lấy từ biến `HVNS_VERSION_CODE` (CI = số lần chạy); iOS `CURRENT_PROJECT_VERSION` (CI = ngày giờ) |
| Android | minSdk 24 · compile/target SDK 36 · JDK 21 · Android Studio bản mới (hỗ trợ AGP của Capacitor 8) |
| iOS | iOS 15.0+ · iPhone & iPad · Swift Package Manager · Xcode 26 (bắt buộc khi nộp App Store từ 28/4/2026) |
| Plugin | App, Preferences, Filesystem, Share, SplashScreen, @capacitor-community/text-to-speech |
| Quyền | Android: chỉ `INTERNET` (mặc định của Capacitor); chọn ảnh đại diện dùng trình chọn tệp của hệ thống nên không cần quyền thêm. iOS: `NSPhotoLibraryUsageDescription`, `NSCameraUsageDescription` trong `Info.plist` — chỉ hỏi khi phụ huynh bấm “Tải ảnh từ máy” |
| Màu thương hiệu | Đỏ `#D71E28` (tối: `#7E0E15`) — `capacitor.config.json`, `android/app/src/main/res/values/hvns_colors.xml`, ảnh gốc trong `assets/` (tạo lại bằng `node web-src/build-app.js` rồi `npm run assets`) |
| Quyền riêng tư iOS | `ios/App/App/PrivacyInfo.xcprivacy`: không theo dõi, không thu thập; khai lý do dùng UserDefaults (CA92.1) và thời gian tệp (C617.1) cho plugin Preferences/Filesystem |
| Mã hóa | `ITSAppUsesNonExemptEncryption = NO` trong `Info.plist` |

## Cấu trúc

```
www/                 giao diện đã đóng gói (app.js, app.css, phông chữ nội bộ, ai-config.js,
                     voice/: giọng đọc tiếng Anh thu sẵn — Kokoro-82M, Apache-2.0 — dạng Opus 24 kbps)
web-src/             mã nguồn giao diện: src/*.js, styles.css, build.js, build-app.js, test/,
                     art/ (ảnh nền các bé: nen-goc.png → make_art.py → *.webp; nhân vật thầy cô 3D
                     teacher-co.webp / teacher-thay.webp — Fluent Emoji © Microsoft, MIT, giấy phép trong art/licenses/)
android/, ios/       dự án gốc (đã chạy `cap sync`)
assets/              ảnh gốc biểu tượng & màn hình chờ (dùng cho `npm run assets`)
store-assets/        biểu tượng cho cửa hàng (1024 không trong suốt, 512)
ai-proxy/            máy chủ trung gian cho Gia sư AI (Cloudflare Worker) + README
scripts/             write-ai-config.js (CI ghi cấu hình Gia sư AI từ Secrets)
.github/workflows/   android.yml (APK + AAB), ios.yml (archive + tải lên TestFlight)
```

## Lệnh thường dùng

```bash
npm ci                     # cài thư viện (Node 22)
npm run build:web          # dựng lại www/ từ web-src/ rồi cap sync (chỉ cần khi sửa mã nguồn giao diện)
npx cap sync               # chép www/ vào android/ và ios/
npx cap open android       # mở Android Studio
npx cap open ios           # mở Xcode (cần máy Mac)
npm test                   # kiểm thử bộ sinh đề, 203 bài giảng, máy chủ trung gian
```

Kiểm thử giao diện đầy đủ (Playwright, Python): `web-src/test/ui_test.py`, `web-src/test/lessons_flow.py`,
`web-src/test/eday_test.py` (Tiếng Anh mỗi ngày), `web-src/test/ai_test.py` — chạy sau `node web-src/build-app.js`. Tạo lại biểu tượng giao diện: `npm i -D lucide-static@0.469.0`
rồi `node web-src/tools-icons.js`.

### Giọng đọc tiếng Anh thu sẵn
Gói giọng nằm ở `www/voice/` (index.json + meta.json + en-*.ogg) và được giữ nguyên khi chạy `node web-src/build-app.js`.
Chỉ cần thu lại khi thêm/sửa câu tiếng Anh: `node web-src/tools-voice.js > web-src/voice/list.json` rồi
`python3 web-src/tools-voice-gen.py web-src/voice/list.json web-src/voice` (cần `pip install kokoro-onnx soundfile`, ffmpeg có libopus và
mô hình `kokoro-v1.0.onnx`, `voices-v1.0.bin` đặt cạnh tệp, hoặc chỉ đường bằng biến `KOKORO_DIR`). Câu không có trong gói được đọc bằng giọng của máy.
Safari đời cũ (trước iOS 18.4) không phát Opus trong vỏ Ogg: ứng dụng tự đổi sang vỏ CAF ngay trên máy (cùng dữ liệu âm thanh).

## Ký và đóng gói Android

- Khóa tải lên (upload key) nằm trong gói **BAO-MAT** riêng, không đưa vào kho mã.
- Gradle tự ký bản `release` khi có 4 biến môi trường: `HVNS_KEYSTORE_FILE`, `HVNS_KEYSTORE_PASSWORD`, `HVNS_KEY_ALIAS`, `HVNS_KEY_PASSWORD`.
- Bằng Android Studio: **Build → Generate Signed App Bundle** → chọn `hvns-upload.jks` → bản `release` → tệp `.aab`.
- Bằng GitHub Actions: tạo Secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
  (giá trị trong `BAO-MAT/KHOA-KY-ANDROID.txt`) → tab **Actions → Android – đóng gói APK & AAB → Run workflow**.
  Kết quả: `app-debug.apk` (cài thử) và `app-release.aab` (nộp Google Play).

## Ký và đóng gói iOS

- Máy Mac + Xcode 26: `npx cap open ios` → target **App → Signing & Capabilities** → chọn Team → **Product → Archive → Distribute App → App Store Connect**.
- Không có Mac: GitHub Actions (`ios.yml`, máy `macos-26`) với 4 Secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64`
  (khóa App Store Connect API, quyền Admin), `APPLE_TEAM_ID`. Quy trình tự ký (cloud signing) và tải bản dựng lên TestFlight.
- Cần tạo trước App ID `vn.hocviengoisao.app` (developer.apple.com → Identifiers) và ứng dụng trong App Store Connect.

## Gia sư AI trong bản cài đặt (tùy chọn)

Mặc định `www/ai-config.js` để trống → bản cài đặt không có Gia sư AI, không gửi dữ liệu đi đâu. Muốn bật: dựng máy chủ theo
`ai-proxy/README.md`, sau đó thêm Secrets `HVNS_AI_ENDPOINT`, `HVNS_AI_APP_KEY` (CI tự ghi cấu hình) hoặc sửa trực tiếp `www/ai-config.js`.
Trong ứng dụng, phụ huynh phải bật ở **Góc phụ huynh → Cài đặt**. Nhớ cập nhật khai báo quyền riêng tư trên hai cửa hàng.

## Lưu ý

- Không đổi `appId` sau khi đã nộp lên cửa hàng. Muốn đổi thì phải đổi trước lần nộp đầu tiên (cả `capacitor.config.json`,
  `android/app/build.gradle`, thư mục gói Java của `MainActivity` và Bundle ID trong Xcode).
- Mỗi lần nộp bản mới: tăng `versionName`/`MARKETING_VERSION` (ví dụ 1.0.1); số bản dựng do CI tự tăng.
- Các quy trình GitHub Actions được viết sẵn nhưng chưa chạy thử trên máy chủ GitHub/Apple thật. Nếu lần chạy đầu báo lỗi,
  xem nhật ký của bước bị đỏ và chỉnh theo thông báo.
