import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATA_DIR ? `${process.env.DATA_DIR}/zcode-bot.db` : './data/zcode-bot.db',
  },
});
