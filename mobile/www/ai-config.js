/* Cấu hình Gia sư AI cho bản cài đặt (App Store / Google Play).
   Để trống aiEndpoint = không có Gia sư AI trong bản cài đặt (mọi tính năng khác vẫn chạy ngoại tuyến).
   Muốn bật: dựng máy chủ trung gian theo ai-proxy/README.md rồi điền vào dòng cuối tệp này
   - aiEndpoint: địa chỉ máy chủ, dạng https://hvns-ai.<tên-tài-khoản>.workers.dev
   - aiKey: chuỗi APP_KEY đã đặt trên máy chủ
   Khi bật, cập nhật mục An toàn dữ liệu (Google Play) và Quyền riêng tư (App Store) theo tài liệu hướng dẫn. */
window.HVNS_CONFIG = {"aiEndpoint":"","aiKey":""};
