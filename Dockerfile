FROM node:24-alpine AS base

FROM base AS builder

WORKDIR /app

COPY package.json yarn.lock ./

RUN yarn install --frozen-lockfile

COPY . .

RUN yarn build

FROM base AS production

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules

COPY --from=builder /app/dist/bot.js ./

COPY --from=builder /app/IDL ./IDL

COPY --from=builder /app/package.json ./

USER node

CMD ["./bot.js"]
