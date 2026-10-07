/* Đăng ký plugin gốc khi chạy trong ứng dụng cài đặt (Capacitor, không dùng bundler) */
(function () {
  var C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform() || !C.registerPlugin) return;
  ['App', 'Preferences', 'Filesystem', 'Share', 'SplashScreen', 'TextToSpeech', 'NativePurchases'].forEach(function (n) {
    try { if (!C.Plugins[n] && C.isPluginAvailable(n)) C.registerPlugin(n); } catch (e) { console.warn(e); }
  });
})();
