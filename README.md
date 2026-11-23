# TON AI SNIPER

Railway-ready Telegram control service for TON market monitoring and fail-closed trading controls.

## Safety state

The service defaults to `ENABLE_LIVE_TRADING=false`. It never uses a primary wallet, never logs credentials, and does not treat an unconfirmed blockchain transaction as successful. Live signing must remain disabled until a dedicated wallet, signer, owner allowlist, and on-chain balance checks are verified.

## Runtime

- Telegram bot: `@TONAISniperBot`
- HTTP health endpoint: `/health`
- PostgreSQL is used for durable audit records when `DATABASE_URL` is present.
- TON market reads use configured TonAPI, STON.fi, and DeDust base URLs. Provider failures fail closed.
- The current release is an operational monitoring/control layer; no real trade is submitted while live signing is disabled.

## Railway variables

Set values from `.env.example` in Railway Variables. Never commit `.env` or paste secrets into source control. Set `TELEGRAM_OWNER_ID` to the numeric Telegram user ID that may control the bot.
