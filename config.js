// 前端配置：代理地址
// 1) 本地用 node server.js 托管时，留空 '' 即可（同域 /api/translate）
// 2) 若把前端部署到 CloudStudio 静态站、代理部署到 Vercel/云函数，
//    把下面的 '' 改成你的代理公网地址，例如 'https://your-proxy.vercel.app'
window.APP_CONFIG = {
  PROXY_URL: ''
};
