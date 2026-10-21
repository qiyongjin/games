import { createXiangqiServer } from './server.mjs';

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 至 65535。');
const server = await createXiangqiServer({
  dataDir: process.env.DATA_DIR,
  adminPassword: process.env.ADMIN_PASSWORD,
  trustProxy: process.env.TRUST_PROXY === '1',
  onError: error => console.error(`服务错误：${error.message}`),
});
server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
server.listen(port, host, () => console.log(`弈步已启动：http://${host.includes(':') ? `[${host}]` : host}:${port}\n管理后台：/admin\n首次随机密码保存在：${server.credentialsPath}（使用 ADMIN_PASSWORD 时不生成此文件）\n按 Ctrl+C 停止。`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(async () => { await server.flush(); process.exit(0); });
  server.closeIdleConnections();
});
