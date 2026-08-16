import { defineConfig } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Dev-only endpoint that lets the running game write a rendered frame to disk.
 *
 * Visual review is done by agents, and screenshotting through the browser pane turned out to be
 * unreliable: the pane gets backgrounded or hidden while several agents share it, and the
 * capture then either times out or returns a stale/blank frame. That produced hours of false
 * "the game renders black" diagnoses.
 *
 * With this, the page POSTs its own canvas to the dev server and any agent can simply Read the
 * PNG off disk. No pane visibility required, no contention, and the frame is exactly what the
 * renderer produced.
 *
 *   POST /__shot   { name: "ridge", png: "data:image/png;base64,..." }  ->  shots/ridge.png
 */
function shotWriter() {
  return {
    name: 'slasher-shot-writer',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end('POST only'); }
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 64 * 1024 * 1024) { res.statusCode = 413; res.end('too large'); req.destroy(); }
        });
        req.on('end', () => {
          try {
            const { name, png } = JSON.parse(body);
            const safe = String(name || 'frame').replace(/[^a-zA-Z0-9._-]/g, '_');
            const b64 = String(png).replace(/^data:image\/png;base64,/, '');
            const dir = join(process.cwd(), 'shots');
            mkdirSync(dir, { recursive: true });
            const file = join(dir, `${safe}.png`);
            writeFileSync(file, Buffer.from(b64, 'base64'));
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, file }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(e && e.message) }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [shotWriter()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  assetsInclude: ['**/*.mp3', '**/*.ogg', '**/*.wav'],
});
