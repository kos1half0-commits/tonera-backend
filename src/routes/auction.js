import { Router } from 'express'
import pool from '../db/index.js'
import { getBot } from '../bot.js'

const router = Router()

// Helper: get auction settings
async function getAuctionSettings() {
  const { rows } = await pool.query(
    "SELECT key, value FROM settings WHERE key LIKE 'auction_%'"
  )
  const s = {}
  rows.forEach(r => s[r.key] = r.value)
  return {
    enabled: s.auction_enabled || '0',
    test_mode: s.auction_test_mode || '1',
    min_price: parseFloat(s.auction_min_price || '0.1'),
    min_step: parseFloat(s.auction_min_step || '0.05'),
    commission: parseFloat(s.auction_commission || '10'),
    max_duration: parseInt(s.auction_max_duration || '24'),
    min_tasks: parseInt(s.auction_min_tasks || '50'),
    min_activity_days: parseInt(s.auction_min_activity_days || '7'),
  }
}

// GET /api/auction/info — auction status & settings
router.get('/info', async (req, res) => {
  try {
    const settings = await getAuctionSettings()
    res.json(settings)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/auction/list — active auctions
router.get('/list', async (req, res) => {
  try {
    const settings = await getAuctionSettings()
    if (settings.enabled === '0') return res.json({ auctions: [], enabled: false })

    const { rows } = await pool.query(`
      SELECT a.*,
        u_seller.username as seller_username, u_seller.first_name as seller_name,
        u_ref.username as ref_username, u_ref.first_name as ref_name, u_ref.telegram_id as ref_tg_id,
        (SELECT COUNT(*) FROM ref_auction_bids WHERE auction_id = a.id) as bid_count,
        (SELECT u2.username FROM ref_auction_bids b JOIN users u2 ON b.bidder_id = u2.id WHERE b.auction_id = a.id ORDER BY b.amount DESC LIMIT 1) as top_bidder,
        (SELECT b.bidder_id FROM ref_auction_bids b WHERE b.auction_id = a.id ORDER BY b.amount DESC LIMIT 1) as top_bidder_id
      FROM ref_auctions a
      JOIN users u_seller ON a.seller_id = u_seller.id
      JOIN users u_ref ON a.referred_user_id = u_ref.id
      WHERE a.status = 'active' AND a.ends_at > NOW()
      ORDER BY a.ends_at ASC
    `)
    res.json({ auctions: rows, enabled: true, test_mode: settings.test_mode === '1' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/auction/ref-profile/:userId — detailed referral activity for buyers
router.get('/ref-profile/:userId', async (req, res) => {
  try {
    const { rows: [user] } = await pool.query(
      `SELECT id, username, first_name, referral_count, created_at
       FROM users WHERE id = $1`,
      [req.params.userId]
    )
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' })

    // Only allow viewing profiles of users on active/completed auctions
    const { rows: [onAuction] } = await pool.query(
      "SELECT id FROM ref_auctions WHERE referred_user_id = $1 AND status IN ('active','completed') LIMIT 1",
      [user.id]
    )
    if (!onAuction) return res.status(403).json({ error: 'Профиль недоступен' })

    // Activity stats
    const { rows: [stats] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM user_tasks WHERE user_id = $1) as tasks_completed,
        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = $1 AND type = 'deposit' AND amount > 0) as total_deposited,
        (SELECT COUNT(*) FROM transactions WHERE user_id = $1 AND type = 'deposit' AND amount > 0) as deposit_count,
        (SELECT COUNT(*) FROM stakes WHERE user_id = $1) as total_stakes,
        (SELECT COALESCE(SUM(amount), 0) FROM stakes WHERE user_id = $1 AND status = 'active') as active_staked,
        (SELECT COUNT(*) FROM transactions WHERE user_id = $1 AND type = 'trading') as trading_count,
        (SELECT COUNT(*) FROM transactions WHERE user_id = $1 AND type = 'spin_result') as spin_count,
        (SELECT COUNT(*) FROM transactions WHERE user_id = $1 AND created_at > NOW() - INTERVAL '7 days') as activity_7d,
        (SELECT COUNT(*) FROM transactions WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days') as activity_30d,
        (SELECT MAX(created_at) FROM transactions WHERE user_id = $1) as last_active
    `, [user.id])

    // Recent transactions (last 15, anonymized amounts)
    const { rows: recentTx } = await pool.query(`
      SELECT type, amount, label, created_at
      FROM transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 15
    `, [user.id])

    // Miner contracts
    const { rows: [minerData] } = await pool.query(`
      SELECT
        COUNT(*) as contract_count,
        COALESCE(SUM(CASE WHEN status='active' THEN hashrate ELSE 0 END), 0) as active_hashrate,
        COALESCE(SUM(earned), 0) as miner_earned
      FROM miner_contracts WHERE user_id = $1
    `, [user.id])

    res.json({
      user: {
        username: user.username,
        first_name: user.first_name,
        referral_count: user.referral_count,
        registered: user.created_at,
      },
      stats: {
        tasks_completed: parseInt(stats.tasks_completed),
        total_deposited: parseFloat(stats.total_deposited),
        deposit_count: parseInt(stats.deposit_count),
        total_stakes: parseInt(stats.total_stakes),
        active_staked: parseFloat(stats.active_staked),
        trading_count: parseInt(stats.trading_count),
        spin_count: parseInt(stats.spin_count),
        activity_7d: parseInt(stats.activity_7d),
        activity_30d: parseInt(stats.activity_30d),
        last_active: stats.last_active,
        miner_contracts: parseInt(minerData.contract_count),
        active_hashrate: parseFloat(minerData.active_hashrate),
        miner_earned: parseFloat(minerData.miner_earned),
      },
      recent_tx: recentTx.map(tx => ({
        type: tx.type,
        label: tx.label?.split('|')[0]?.slice(0, 40) || tx.type,
        created_at: tx.created_at,
      })),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/auction/:id — auction detail with bids
router.get('/:id', async (req, res) => {
  try {
    const { rows: [auction] } = await pool.query(`
      SELECT a.*,
        u_seller.username as seller_username, u_seller.first_name as seller_name,
        u_ref.username as ref_username, u_ref.first_name as ref_name, u_ref.telegram_id as ref_tg_id,
        u_ref.referral_count as ref_referral_count
      FROM ref_auctions a
      JOIN users u_seller ON a.seller_id = u_seller.id
      JOIN users u_ref ON a.referred_user_id = u_ref.id
      WHERE a.id = $1
    `, [req.params.id])
    if (!auction) return res.status(404).json({ error: 'Аукцион не найден' })

    const { rows: bids } = await pool.query(`
      SELECT b.*, u.username, u.first_name
      FROM ref_auction_bids b
      JOIN users u ON b.bidder_id = u.id
      WHERE b.auction_id = $1
      ORDER BY b.amount DESC
    `, [req.params.id])

    res.json({ auction, bids })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/auction/create — create auction lot
router.post('/create', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { referral_id, start_price, duration_hours } = req.body
    const settings = await getAuctionSettings()

    if (settings.enabled === '0') return res.status(400).json({ error: 'Аукцион отключён' })

    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [tgId])
    if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Пользователь не найден' }) }

    // Check referral belongs to this user (with lock)
    const { rows: [ref] } = await client.query(
      'SELECT * FROM referrals WHERE id = $1 AND referrer_id = $2 FOR UPDATE',
      [referral_id, user.id]
    )
    if (!ref) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Реферал не найден или не ваш' }) }

    // Eligibility checks (skip for admins)
    if (!user.is_admin) {
      // Check referred user completed minimum tasks
      const { rows: [taskStats] } = await client.query(
        'SELECT COUNT(*) as cnt FROM user_tasks WHERE user_id = $1',
        [ref.referred_id]
      )
      if (parseInt(taskStats.cnt) < settings.min_tasks) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: `Реферал должен выполнить минимум ${settings.min_tasks} заданий (сейчас: ${taskStats.cnt})` })
      }

      // Check referred user was active within required days
      const { rows: [activity] } = await client.query(
        `SELECT COUNT(*) as cnt FROM transactions 
         WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 day' * $2`,
        [ref.referred_id, settings.min_activity_days]
      )
      if (parseInt(activity.cnt) === 0) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: `Реферал должен быть активен за последние ${settings.min_activity_days} дней` })
      }
    }

    // Check not already on auction (with lock on ref_auctions to prevent race)
    const { rows: [existing] } = await client.query(
      "SELECT id FROM ref_auctions WHERE referral_id = $1 AND status = 'active' FOR UPDATE",
      [referral_id]
    )
    if (existing) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Этот реферал уже на аукционе' }) }

    const price = parseFloat(start_price)
    if (isNaN(price) || price < settings.min_price) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Минимальная цена: ${settings.min_price} TON` })
    }

    const hours = parseInt(duration_hours) || 24
    if (hours < 1 || hours > settings.max_duration) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Длительность: 1-${settings.max_duration} часов` })
    }

    const isTest = settings.test_mode === '1'
    const endsAt = new Date(Date.now() + hours * 3600000)

    const { rows: [auction] } = await client.query(
      `INSERT INTO ref_auctions (seller_id, referral_id, referred_user_id, start_price, current_price, min_step, duration_hours, ends_at, is_test)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8) RETURNING *`,
      [user.id, referral_id, ref.referred_id, price, settings.min_step, hours, endsAt, isTest]
    )
    await client.query('COMMIT')

    res.json({ ok: true, auction })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

// POST /api/auction/:id/bid — place a bid
router.post('/:id/bid', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount } = req.body
    const settings = await getAuctionSettings()

    if (settings.enabled === '0') return res.status(400).json({ error: 'Аукцион отключён' })

    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE', [tgId])
    if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Пользователь не найден' }) }

    const { rows: [auction] } = await client.query(
      "SELECT * FROM ref_auctions WHERE id = $1 AND status = 'active' FOR UPDATE",
      [req.params.id]
    )
    if (!auction) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Аукцион не найден или завершён' }) }

    // Can't bid on own auction
    if (auction.seller_id === user.id) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Нельзя делать ставку на свой аукцион' })
    }

    // Check auction not expired
    if (new Date(auction.ends_at) <= new Date()) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Аукцион уже завершён' })
    }

    const bidAmount = parseFloat(amount)
    const currentPrice = parseFloat(auction.current_price)
    const minBid = Math.round((currentPrice + parseFloat(auction.min_step)) * 10000) / 10000

    if (isNaN(bidAmount) || bidAmount < minBid) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Минимальная ставка: ${minBid.toFixed(4)} TON` })
    }

    const isTest = settings.test_mode === '1'

    // Get previous top bid (to refund their locked funds)
    const { rows: [prevTopBid] } = await client.query(
      'SELECT * FROM ref_auction_bids WHERE auction_id = $1 ORDER BY amount DESC LIMIT 1',
      [auction.id]
    )

    // In production mode: lock funds
    if (!isTest) {
      const bal = parseFloat(user.balance_ton)
      if (bal < bidAmount) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Недостаточно средств' })
      }

      // Lock bid amount from bidder balance
      await client.query(
        'UPDATE users SET balance_ton = balance_ton - $1 WHERE id = $2 AND balance_ton >= $1',
        [bidAmount, user.id]
      )

      // Refund previous top bidder (if different user)
      if (prevTopBid && prevTopBid.bidder_id !== user.id) {
        await client.query(
          'UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2',
          [parseFloat(prevTopBid.amount), prevTopBid.bidder_id]
        )
      }
      // If same user made previous top bid — refund their old amount
      if (prevTopBid && prevTopBid.bidder_id === user.id) {
        await client.query(
          'UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2',
          [parseFloat(prevTopBid.amount), user.id]
        )
      }
    }

    // Place bid
    await client.query(
      'INSERT INTO ref_auction_bids (auction_id, bidder_id, amount) VALUES ($1, $2, $3)',
      [auction.id, user.id, bidAmount]
    )

    // Update current price
    await client.query(
      'UPDATE ref_auctions SET current_price = $1 WHERE id = $2',
      [bidAmount, auction.id]
    )

    await client.query('COMMIT')

    // Notifications (best-effort, after commit)
    try {
      const bot = getBot()
      if (bot) {
        const { rows: [seller] } = await pool.query('SELECT telegram_id FROM users WHERE id = $1', [auction.seller_id])
        const { rows: [refUser] } = await pool.query('SELECT username, first_name FROM users WHERE id = $1', [auction.referred_user_id])
        const bidderName = user.username ? `@${user.username}` : user.first_name || 'Пользователь'
        const refName = refUser?.username ? `@${refUser.username}` : refUser?.first_name || 'Реферал'
        const bidCount = await pool.query('SELECT COUNT(*) as cnt FROM ref_auction_bids WHERE auction_id = $1', [auction.id])
        const cnt = parseInt(bidCount.rows[0].cnt)

        // Notify seller
        if (seller) {
          bot.sendMessage(seller.telegram_id,
            `🏛 <b>Новая ставка на ваш аукцион!</b>\n\n` +
            `👤 Реферал: <b>${refName}</b>\n` +
            `💰 Ставка: <b>${bidAmount.toFixed(4)} TON</b>\n` +
            `👤 Участник: ${bidderName}\n` +
            `📊 Всего ставок: ${cnt}\n` +
            `⏱ Лот #${auction.id}`,
            { parse_mode: 'HTML' }
          ).catch(() => {})
        }

        // Notify outbid user (if different from current bidder)
        if (prevTopBid && prevTopBid.bidder_id !== user.id) {
          const { rows: [outbidUser] } = await pool.query('SELECT telegram_id FROM users WHERE id = $1', [prevTopBid.bidder_id])
          if (outbidUser) {
            const prevAmount = parseFloat(prevTopBid.amount).toFixed(4)
            bot.sendMessage(outbidUser.telegram_id,
              `🏛 <b>Вашу ставку перебили!</b>\n\n` +
              `👤 Реферал: <b>${refName}</b>\n` +
              `💰 Ваша ставка: <b>${prevAmount} TON</b> → перебита\n` +
              `💰 Новая цена: <b>${bidAmount.toFixed(4)} TON</b>\n` +
              `${isTest ? '' : '💵 Средства разблокированы\n'}` +
              `⏱ Лот #${auction.id}`,
              { parse_mode: 'HTML' }
            ).catch(() => {})
          }
        }
      }
    } catch (e) { /* notifications are best-effort */ }

    res.json({ ok: true, new_price: bidAmount })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

// POST /api/auction/:id/cancel — cancel own auction (only if no bids)
router.post('/:id/cancel', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT id FROM users WHERE telegram_id = $1', [tgId])
    if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Пользователь не найден' }) }

    const { rows: [auction] } = await client.query(
      "SELECT * FROM ref_auctions WHERE id = $1 AND seller_id = $2 AND status = 'active' FOR UPDATE",
      [req.params.id, user.id]
    )
    if (!auction) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Аукцион не найден' }) }

    const { rows: [bidCount] } = await client.query(
      'SELECT COUNT(*) as cnt FROM ref_auction_bids WHERE auction_id = $1',
      [auction.id]
    )
    if (parseInt(bidCount.cnt) > 0) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Нельзя отменить — уже есть ставки' })
    }

    await client.query("UPDATE ref_auctions SET status = 'cancelled' WHERE id = $1", [auction.id])
    await client.query('COMMIT')
    res.json({ ok: true })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

// GET /api/auction/my — my auctions and bids
router.get('/my/all', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [tgId])
    if (!user) return res.json({ selling: [], bidding: [] })

    // My auctions (as seller)
    const { rows: selling } = await pool.query(`
      SELECT a.*,
        u_ref.username as ref_username, u_ref.first_name as ref_name,
        (SELECT COUNT(*) FROM ref_auction_bids WHERE auction_id = a.id) as bid_count,
        u_winner.username as winner_username, u_winner.first_name as winner_name
      FROM ref_auctions a
      JOIN users u_ref ON a.referred_user_id = u_ref.id
      LEFT JOIN users u_winner ON a.winner_id = u_winner.id
      WHERE a.seller_id = $1
      ORDER BY a.created_at DESC
      LIMIT 50
    `, [user.id])

    // My bids (only latest per auction)
    const { rows: bidding } = await pool.query(`
      SELECT DISTINCT ON (b.auction_id) b.*, a.status as auction_status, a.current_price, a.ends_at, a.winner_id, a.referred_user_id,
        u_ref.username as ref_username, u_ref.first_name as ref_name,
        u_seller.username as seller_username, u_seller.first_name as seller_name
      FROM ref_auction_bids b
      JOIN ref_auctions a ON b.auction_id = a.id
      JOIN users u_ref ON a.referred_user_id = u_ref.id
      JOIN users u_seller ON a.seller_id = u_seller.id
      WHERE b.bidder_id = $1
      ORDER BY b.auction_id, b.amount DESC
    `, [user.id])

    res.json({ selling, bidding })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
