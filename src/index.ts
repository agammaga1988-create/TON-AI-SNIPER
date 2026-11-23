import 'dotenv/config';
import express from 'express';
import { Bot, Context } from 'grammy';
import pg from 'pg';
import pino from 'pino';
import { z } from 'zod';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const env = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_OWNER_ID: z.coerce.number().int().positive(),
  TONAPI_BASE_URL: z.string().url().default('https://tonapi.io/v2'),
  TONAPI_KEY: z.string().optional(),
  STONFI_API_URL: z.string().url().default('https://api.ston.fi/v1'),
  DEDUST_API_URL: z.string().url().default('https://api.dedust.io/v2'),
  ENABLE_LIVE_TRADING: z.enum(['true', 'false']).default('false'),
  TRADING_WALLET_ADDRESS: z.string().optional(),
  STANDARD_POSITION_TON: z.coerce.number().positive().default(1),
  MAX_OPEN_POSITIONS: z.coerce.number().int().positive().max(3).default(3),
  PROTECTED_RESERVE_TON: z.coerce.number().min(5).default(5),
  DAILY_LOSS_LIMIT_TON: z.coerce.number().positive().default(1),
  MIN_SCORE_TO_TRADE: z.coerce.number().int().min(0).max(100).default(75)
}).parse(process.env);

const pool = env.DATABASE_URL ? new pg.Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
let paused = true;
let lastScanAt: Date | null = null;
let lastScanCount = 0;

async function db(sql: string, values: unknown[] = []) {
  if (!pool) return;
  const client = await pool.connect();
  try { await client.query(sql, values); } finally { client.release(); }
}

async function initDb() {
  if (!pool) return;
  await db(`CREATE TABLE IF NOT EXISTS audit_events (
    id BIGSERIAL PRIMARY KEY, event_type TEXT NOT NULL, payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db(`CREATE TABLE IF NOT EXISTS bot_state (
    key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

async function audit(eventType: string, payload: Record<string, unknown>) {
  log.info({ eventType, payload }, 'audit');
  await db('INSERT INTO audit_events(event_type, payload) VALUES($1, $2)', [eventType, payload]);
}

function ownerOnly(ctx: Context) {
  return ctx.from?.id === env.TELEGRAM_OWNER_ID;
}

function money(n: number) { return `${n.toFixed(3)} TON`; }

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`provider_http_${res.status}`);
  return res.json() as Promise<unknown>;
}

async function scanMarkets() {
  const headers: Record<string, string> = env.TONAPI_KEY ? { Authorization: `Bearer ${env.TONAPI_KEY}` } : {};
  const [jettons, pools] = await Promise.allSettled([
    fetchJson(`${env.TONAPI_BASE_URL}/jettons`, headers),
    fetchJson(`${env.DEDUST_API_URL}/pools`)
  ]);
  const count = (jettons.status === 'fulfilled' && Array.isArray((jettons.value as any)?.jettons))
    ? (jettons.value as any).jettons.length : 0;
  const poolCount = pools.status === 'fulfilled' && Array.isArray(pools.value) ? (pools.value as any[]).length : 0;
  lastScanAt = new Date();
  lastScanCount = count + poolCount;
  await audit('market_scan', { jettons: count, pools: poolCount, failed: [jettons, pools].filter(x => x.status === 'rejected').length });
  return { jettons: count, pools: poolCount };
}

function dashboardText() {
  return [
    'TON AI SNIPER',
    '',
    `State: ${paused ? 'PAUSED (safe default)' : 'MONITORING'}`,
    `Live trading: ${env.ENABLE_LIVE_TRADING === 'true' ? 'AUTHORIZED FLAG SET' : 'DISABLED'}`,
    `Position size: ${money(env.STANDARD_POSITION_TON)}`,
    `Max positions: ${env.MAX_OPEN_POSITIONS}`,
    `Protected reserve: ${money(env.PROTECTED_RESERVE_TON)}`,
    `Min score: ${env.MIN_SCORE_TO_TRADE}/100`,
    `Last scan: ${lastScanAt?.toISOString() ?? 'never'}`,
    `Observed records: ${lastScanCount}`,
    '',
    'No wallet transaction is submitted by this release.'
  ].join('\n');
}

async function requireOwner(ctx: Context) {
  if (!ownerOnly(ctx)) { await ctx.reply('Unauthorized.'); return false; }
  return true;
}

bot.command('start', async ctx => { if (await requireOwner(ctx)) await ctx.reply('TON AI SNIPER is online in safe mode. Use /dashboard.'); });
bot.command('dashboard', async ctx => { if (await requireOwner(ctx)) await ctx.reply(dashboardText()); });
bot.command('pause', async ctx => { if (await requireOwner(ctx)) { paused = true; await audit('pause', { by: ctx.from?.id }); await ctx.reply('Trading and new entries paused.'); } });
bot.command('resume', async ctx => { if (await requireOwner(ctx)) { paused = false; await audit('resume', { by: ctx.from?.id }); await ctx.reply('Monitoring resumed. Live trading remains disabled unless explicitly configured and verified.'); } });
bot.command('scan', async ctx => {
  if (!(await requireOwner(ctx))) return;
  try { const result = await scanMarkets(); await ctx.reply(`Scan complete: ${result.jettons} jetton records, ${result.pools} pool records.`); }
  catch (err) { log.error({ err }, 'scan failed'); await ctx.reply('Scan failed closed; no trade was attempted.'); }
});
bot.command('risk', async ctx => { if (await requireOwner(ctx)) await ctx.reply(`Risk limits:\n- ${money(env.STANDARD_POSITION_TON)} standard position\n- ${env.MAX_OPEN_POSITIONS} max simultaneous positions\n- ${money(env.PROTECTED_RESERVE_TON)} protected reserve\n- ${money(env.DAILY_LOSS_LIMIT_TON)} daily loss halt\n- ${env.MIN_SCORE_TO_TRADE}/100 minimum score`); });
bot.command('positions', async ctx => { if (await requireOwner(ctx)) await ctx.reply('No live positions are tracked until a dedicated wallet and confirmed execution adapter are enabled.'); });
bot.command('emergency', async ctx => { if (await requireOwner(ctx)) { paused = true; await audit('emergency_pause', { by: ctx.from?.id }); await ctx.reply('Emergency pause enabled. No new transaction will be submitted.'); } });

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true, service: 'ton-ai-sniper', paused, liveTrading: env.ENABLE_LIVE_TRADING === 'true', lastScanAt }));
app.get('/', (_req, res) => res.json({ service: 'TON AI SNIPER', telegram: '@TONAISniperBot', safeMode: paused }));

await initDb();
app.listen(env.PORT, '0.0.0.0', () => log.info({ port: env.PORT }, 'http server listening'));
bot.catch(err => log.error({ err }, 'telegram bot error'));
bot.start({ onStart: info => log.info({ username: info.username }, 'telegram bot started') });
setInterval(() => { if (!paused) scanMarkets().catch(err => log.error({ err }, 'scheduled scan failed')); }, 60_000);
