import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app.js';

const host = process.env.SSP_HOST || '127.0.0.1';
const port = Number(process.env.SSP_PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSP_PORT 1–65535 aralığında olmalı.');
const app = createApp({ dataDir: process.env.SSP_DATA_DIR || resolve('data') });
const web = resolve('dist');
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  next();
});
app.use('/api', (_req, res) => { res.status(404).json({ error: 'API adresi bulunamadı.' }); });
if (existsSync(resolve(web, 'index.html'))) {
  app.use(express.static(web, { index: false, maxAge: 0 }));
  app.get('/{*path}', (_req, res) => { res.sendFile(resolve(web, 'index.html')); });
} else {
  app.get('/', (_req, res) => { res.type('text').send('SSP API hazır. Arayüz için npm run dev:web veya npm run build çalıştırın.'); });
}
const server = app.listen(port, host, () => console.log(`SSP hazır: http://${host}:${port}`));
server.on('error', (error) => { console.error('SSP başlatılamadı:', error.message); process.exitCode = 1; });
function shutdown() {
  server.close(() => { app.locals.close?.(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

