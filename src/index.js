import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { telegramAuth } from './middleware/telegramAuth.js'
import { runMigrations } from './db/migrations.js'
import { startCronJobs, startPartnershipChecks } from './cron/stakingRewards.js'
import { startMinerAccrual } from './cron/minerAccrual.js'
import { startAuctionCron } from './cron/auctionCron.js'
import { startPartnershipCron } from './cron/partnershipCron.js'
import { initBot, setupBotHandlers, processUpdate } from './bot.js'
import { BOT_USERNAME } from './config.js'
import pool from './db/index.js'
import authRoutes     from './routes/auth.js'
import stakingRoutes  from './routes/staking.js'
import tasksRoutes    from './routes/tasks.js'
import referralRoutes from './routes/referrals.js'
import walletRoutes   from './routes/wallet.js'
import adminRoutes    from './routes/admin.js'
import depositRoutes  from './routes/deposit.js'
import spinRoutes     from './routes/spin.js'
import tradingRoutes  from './routes/trading.js'
import supportRoutes  from './routes/support.js'
import newsRoutes        from './routes/news.js'
import partnershipRoutes from './routes/partnership.js'
import promoRoutes       from './routes/promo.js'
import minerRoutes      from './routes/miner.js'
import adsRoutes        from './routes/ads.js'
import slotsRoutes    from './routes/slots.js'
import channelsRoutes from './routes/channels.js'
import bonusRoutes    from './routes/bonus.js'
import auctionRoutes  from './routes/auction.js'

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors({ origin: '*' }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// settings endpoint перенесён после telegramAuth

app.get('/health', (_, res) => res.json({ ok: true, bot: BOT_USERNAME }))

// Редирект с браузера в Telegram
app.get('/', (req, res) => {
  const ua = req.headers['user-agent'] || ''
  if (!ua.includes('TelegramBot') && !ua.includes('Telegram')) {
    return res.redirect(`https://t.me/${BOT_USERNAME}`)
  }
  res.json({ ok: true })
})

app.get('/set-webhook', async (req, res) => {
  // Защита: только по секретному ключу или из localhost
  const secret = req.query.secret
  if (secret !== process.env.BOT_TOKEN?.slice(0, 10)) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  try {
    const { getBot } = await import('./bot.js')
    const bot = getBot()
    const webhookUrl = process.env.WEBHOOK_URL || `${process.env.APP_URL}/bot/webhook`
    await bot.setWebHook(webhookUrl)
    res.json({ ok: true, webhook: webhookUrl })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/bot/webhook', (req, res) => {
  processUpdate(req.body)
  res.sendStatus(200)
})

// Перемещён под telegramAuth ниже

app.use('/api/channels',  channelsRoutes)
app.use('/api', telegramAuth)

app.get('/api/settings/:key', async (req, res) => {
  try {
    const { rows: [s] } = await pool.query('SELECT value FROM settings WHERE key=$1', [req.params.key])
    res.json({ value: s?.value ?? null })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
app.use('/api/auth',      authRoutes)
app.use('/api/staking',   stakingRoutes)
app.use('/api/tasks',     tasksRoutes)
app.use('/api/referrals', referralRoutes)
app.use('/api/wallet',    walletRoutes)
app.use('/api/user',      walletRoutes)
app.use('/api/admin',     adminRoutes)
app.use('/api/deposit',   depositRoutes)
app.use('/api/spin',      spinRoutes)
app.use('/api/trading',   tradingRoutes)
app.use('/api/support',   supportRoutes)
app.use('/api/news',         newsRoutes)
app.use('/api/partnership',  partnershipRoutes)
app.use('/api/promo',        promoRoutes)
app.use('/api/miner',       minerRoutes)
app.use('/api/ads',         adsRoutes)
app.use('/api/slots',     slotsRoutes)
app.use('/api/bonus',     bonusRoutes)
app.use('/api/auction',   auctionRoutes)

async function bootstrap() {
  await runMigrations()
  startCronJobs()
  startPartnershipChecks()
  startMinerAccrual()
  startAuctionCron()
  startPartnershipCron()
  const bot = initBot()
  if (bot) setupBotHandlers(bot)
  app.listen(PORT, () => console.log(`🚀 Tonera backend on port ${PORT}`))
}

bootstrap().catch(console.error)
