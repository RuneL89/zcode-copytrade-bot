/**
 * Start the app in demo mode for this run (MODE stays as configured in .env).
 * Demo mode is fully in-memory and fictional; nothing touches live tables.
 */
process.env.MODE = 'demo';
if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = 'demo-only-insecure-secret-not-for-production';
await import('../index.js');
