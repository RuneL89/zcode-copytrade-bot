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
    console.log(`Copydesk listening on http://${config.env.HOST}:${info.port} (mode: ${config.mode})`);
    console.log(`Workspace: ${REPO_ROOT}`);
    console.log(`Data:      ${config.env.DATA_DIR}`);
  });

  const shutdown = (signal: string) => {
    // Why the server stopped must never be a mystery: a console-window close
    // (SIGHUP on Windows), a Ctrl+C and a service stop all land here.
    console.log(`\n${signal} received — shutting down…`);
    try {
      repo.audit(rt.db.db, 'system', `runtime stopping (${signal})`, {});
    } catch {
      // The audit is best effort; the shutdown itself must proceed.
    }
    server.close();
    rt.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // Node's default for an unhandled rejection is to crash the process. A live
  // trading bot dying silently between ticks is the worst outcome, so the
  // rejection is recorded (audit + console) and the process keeps running; a
  // genuine uncaught exception still exits, but leaves the reason behind.
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`[copydesk] unhandled rejection: ${detail}`);
    try {
      repo.audit(rt.db.db, 'system', `unhandled rejection (continuing): ${detail.slice(0, 300)}`, {});
    } catch {
      // The database may be the cause; console already carries it.
    }
  });
  process.on('uncaughtException', (err) => {
    console.error('[copydesk] uncaught exception:', err);
    try {
      repo.audit(rt.db.db, 'system', `uncaught exception — exiting: ${String(err).slice(0, 300)}`, {});
    } catch {
      // best effort
    }
    rt.stop();
    process.exit(1);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
