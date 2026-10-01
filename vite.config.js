import { defineConfig } from 'vite';

const PORT = Number(process.env.HOST_PORT || 8080);

function addHealth(middlewares) {
  middlewares.use('/healthz', (_req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ status: 'ok', service: 'avionics-key-rotation-review' }));
  });
}

// 开发服务器与生产预览（dist 静态产物）均提供 /healthz。
const healthPlugin = () => ({
  name: 'health-endpoint',
  configureServer(server) {
    addHealth(server.middlewares);
  },
  configurePreviewServer(server) {
    addHealth(server.middlewares);
  },
});

export default defineConfig({
  plugins: [healthPlugin()],
  server: { host: '0.0.0.0', port: PORT },
  preview: { host: '0.0.0.0', port: PORT },
});
