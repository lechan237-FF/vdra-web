import { createApp } from './src/app.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const offline = process.env.VDRA_OFFLINE === '1';

const app = await createApp({ port, host, offline, dataDir: process.env.DATA_DIR || undefined });
console.log(`\n  VDra Web  →  http://localhost:${app.port}\n`);

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    console.log('\n  shutting down (saving rooms)…');
    await app.close();
    process.exit(0);
  });
}
