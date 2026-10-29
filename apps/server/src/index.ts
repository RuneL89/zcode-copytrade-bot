import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import * as repo from '@zcode-bot/db/repo.js';
import { buildApp } from './http/app.js';
import { Runtime } from './runtime.js';
import { loadAppConfig, REPO_ROOT, webDist } from './bootstrap.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

async function main() {
  const config = loadAppConfig();
  const rt = new Runtime(config);
  await rt.start();

  const app = buildApp(rt);

  // Serve the built SPA from the same process (single production image).
  // Cache rules: hashed /assets files are immutable; the document itself must
  // always revalidate, or phones keep serving a stale index.html after an
  // update. Missing /assets files must 404 — falling back to the SPA document
  // would hand a stale client HTML as JavaScript and blank the page.
  const dist = webDist();
  if (existsSync(join(dist, 'index.html'))) {
    const root = relative(process.cwd(), dist).split('\\').join('/');
    app.use(
      '/*',
      serveStatic({
        root,
        onFound: (_path, c) => {
          c.header(
            'Cache-Control',
            c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
          );
        },
      }),
    );
    app.get('/assets/*', (c) => c.notFound());
    app.get('*', (c) => {
      const path = c.req.path;
      if (path.startsWith('/api') || path.startsWith('/internal')) return c.notFound();
      c.header('Cache-Control', 'no-cache');
      return c.html(readFileSync(join(dist, 'index.html'), 'utf8'));
    });
  }

  if (repo.countUsers(rt.db.db) === 0) {
    const token = rt.ensureSetupToken();
    console.log('\n==========================================================');
    console.log('  FIRST-RUN SETUP');
    console.log('  Open the dashboard and complete the setup wizard.');
    console.log(`  One-time setup token (also in ${join(config.env.DATA_DIR, 'setup-token.txt')}):`);
    console.log(`  ${token.value}`);
    console.log('  (valid for 30 minutes)');
    console.log('==========================================================\n');
  }

  const server = serve({ fetch: app.fetch, port: config.env.PORT, hostname: config.env.HOST }, (info) => {
    console.log(`ZCode Bot listening on http://${config.env.HOST}:${info.port} (mode: ${config.mode})`);
    console.log(`Workspace: ${REPO_ROOT}`);
    console.log(`Data:      ${config.env.DATA_DIR}`);
  });

  const shutdown = () => {
    console.log('\nshutting down…');
    server.close();
    rt.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
