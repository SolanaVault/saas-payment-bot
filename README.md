# SaaS payment bot

This bot automates the payment of your SaaS invoices. To set it up, do the following:

1. Fork this repo
2. Add the env variables below to the repo **secrets** (in the repo settings -> Secrets and Variables -> secrets)
3. Keep the SOL balance of the payer wallet topped up and you never have to think about invoices again!

If you mark the repository as private and have a free Github account, please keep in mind that github stops cron automations after 60 days. You can circumvent this by making the repo public, paying a github subscription, or making a random commit at least every 60 days.

## Env vars

```
RPC_URL=your rpc url
PRIVATE_KEY=private key of payer wallet
VOTE_KEY=validator vote account public key
DISCORD_WEBHOOK_URL=optional Discord webhook URL for success/failure notifications
```

The payer wallet can be any wallet that pays the SaaS invoices, so it does not have to be a wallet connected to your validator. The private key should be in the `[1,2,3,...]` format.

You can of course run this script locally in your own environment as well.

## Discord notifications (optional)

If `DISCORD_WEBHOOK_URL` is set, the bot will post a rich embed to that Discord channel:

- **On success** — a green embed with the number of invoices paid, total vSOL amount, a clickable Solscan link for the transaction, and the epochs paid.
- **On failure** — a red embed with the error message.

When there are no invoices to pay, the bot stays silent (no notification).

To create a webhook:

1. In Discord, go to the target channel → **Edit Channel** → **Integrations** → **Webhooks** → **New Webhook**.
2. Copy the webhook URL.
3. Add it to your repository secrets as `DISCORD_WEBHOOK_URL` (Settings → Secrets and variables → Actions → New repository secret).

If the variable is not set, the bot simply skips notifications and behaves as before. Webhook errors are logged but never crash the bot.

## Containerized version

The main branch contains code to run the bot inside Github actions. If you want to automate the bot in your own containerised environment with more modern dev tools, @mindrunner created this PR that introduces significant changes to modernize and enhance the SaaS Payment Bot project, including improvements in build processes, deployment options, and code quality. Key updates include the introduction of Docker support, a shift to Node.js 24, improved environment configuration, and the addition of a recurring job feature via cron. Below is a categorized summary of the most important changes:

See PR here: https://github.com/SolanaVault/saas-payment-bot/pull/1
