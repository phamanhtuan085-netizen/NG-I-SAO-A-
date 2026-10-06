# Ngôi Sao A+

**Toán song ngữ Anh – Việt · Tiếng Anh · Tư duy** cho học sinh mầm non đến lớp 9.

- Trang giới thiệu và tải app: https://phamanhtuan085-netizen.github.io/NG-I-SAO-A-/
- Dùng ngay trên trình duyệt (cài được lên màn hình chính iPhone/Android): https://phamanhtuan085-netizen.github.io/NG-I-SAO-A-/app/
- File cài đặt Android (APK) mới nhất: https://github.com/phamanhtuan085-netizen/NG-I-SAO-A-/releases/latest/download/NgoiSaoAPlus.apk

## Cấu trúc kho

| Thư mục | Nội dung |
|---|---|
| `site/` | Trang giới thiệu, chính sách quyền riêng tư, hình ảnh |
| `mobile/` | Dự án ứng dụng (Capacitor 8): `www/` là bản web đã đóng gói, `android/`, `ios/` là dự án gốc |
| `.github/workflows/pages.yml` | Tự đăng trang giới thiệu + web-app lên GitHub Pages khi có thay đổi |
| `.github/workflows/android.yml` | Tự đóng gói APK (link tải cố định) và AAB (nộp Google Play) |
| `.github/workflows/ios.yml` | Đóng gói iOS và tải lên TestFlight (chạy tay, cần tài khoản Apple Developer) |

Khóa ký và mật khẩu **không** nằm trong kho: chúng được nạp vào *Settings → Secrets and variables → Actions*.
