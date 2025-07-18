# SaaS Payment Bot

This bot automates the payment of your SaaS invoices on Solana. It fetches outstanding invoices for your validator and pays them automatically using vSOL.

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- Docker (optional, for containerized deployment)
- Yarn package manager

## Setup

### Local Development

1. **Clone and install dependencies:**
   ```bash
   git clone <repo-url>
   cd saas-payment-bot
   
   # Use correct Node version
   nvm use
   
   # Install dependencies
   yarn install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your actual values
   ```

3. **Run the bot:**
   ```bash
   # Development mode (TypeScript with hot reload)
   yarn dev
   
   # Production build and run
   yarn build
   yarn start
   
   # Or legacy run command
   yarn run
   ```

### Docker Deployment

1. **Build and run:**
   ```bash
   # One-time execution
   docker-compose up payment-bot
   
   # For scheduled runs (uncomment cron service in docker-compose.yml)
   docker-compose up payment-bot-cron
   ```

2. **Manual Docker commands:**
   ```bash
   docker build -t saas-payment-bot .
   docker run --env-file .env saas-payment-bot
   ```

## Environment Variables

Create a `.env` file based on `.env.example`:

```bash
# Your Solana RPC URL
RPC_URL=https://api.mainnet-beta.solana.com

# Private key of payer wallet in [1,2,3,...] format
PRIVATE_KEY=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64]

# Validator vote account public key
VOTE_KEY=your_vote_account_public_key_here
```

**Note:** The payer wallet can be any wallet that pays the SaaS invoices - it doesn't have to be connected to your validator.

## GitHub Actions Setup

For automated payments via GitHub Actions:

1. Fork this repository
2. Add environment variables to repo **secrets** (Settings → Secrets and Variables → Actions)
3. Keep the SOL balance of the payer wallet topped up
4. The bot will run automatically on schedule

**Important:** For private repos on free GitHub accounts, cron jobs stop after 60 days of inactivity. Solutions:
- Make the repository public
- Upgrade to GitHub Pro
- Make a commit every 60 days

## Scripts

- `yarn dev` - Development mode with tsx
- `yarn build` - Build with tsup for production
- `yarn start` - Run built output
- `yarn run` - Legacy tsx execution

## Docker Architecture

The Dockerfile uses a multi-stage build:
- **Builder stage:** Installs all dependencies and builds TypeScript
- **Production stage:** Contains only runtime dependencies and compiled code

This approach results in smaller, faster production images.
