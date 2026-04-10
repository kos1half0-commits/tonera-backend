import pool from '../db/index.js'
import { getBot } from '../bot.js'

export function startAuctionCron() {
  // Check every 30 seconds for expired auctions
  setInterval(async () => {
    try {
      await processExpiredAuctions()
    } catch (e) {
      console.error('Auction cron error:', e.message)
    }
  }, 30000)

  console.log('🏛 Auction cron started')
}

async function processExpiredAuctions() {
  // Find expired active auctions
  const { rows: expired } = await pool.query(`
    SELECT a.* FROM ref_auctions a
    WHERE a.status = 'active' AND a.ends_at <= NOW()
  `)

  for (const auction of expired) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Get ALL bids sorted by amount DESC (for fallback)
      const { rows: allBids } = await client.query(
        'SELECT * FROM ref_auction_bids WHERE auction_id = $1 ORDER BY amount DESC',
        [auction.id]
      )

      if (allBids.length === 0) {
        // No bids — cancel auction
        await client.query(
          "UPDATE ref_auctions SET status = 'cancelled' WHERE id = $1",
          [auction.id]
        )
        await client.query('COMMIT')
        console.log(`🏛 Auction #${auction.id} cancelled (no bids)`)

        // Notify seller — no bids
        try {
          const bot = getBot()
          if (bot) {
            const { rows: [seller] } = await pool.query('SELECT telegram_id FROM users WHERE id = $1', [auction.seller_id])
            const { rows: [refUser] } = await pool.query('SELECT username, first_name FROM users WHERE id = $1', [auction.referred_user_id])
            if (seller) {
              const refName = refUser?.username ? `@${refUser.username}` : refUser?.first_name || 'Реферал'
              bot.sendMessage(seller.telegram_id,
                `🏛 <b>Аукцион завершён</b>\n\n` +
                `👤 Реферал: <b>${refName}</b>\n` +
                `❌ Никто не сделал ставку\n` +
                `📋 Реферал остаётся у вас`,
                { parse_mode: 'HTML' }
              ).catch(() => {})
            }
          }
        } catch (e) { /* best-effort */ }

        continue
      }

      // Get settings
      const { rows: settings } = await client.query(
        "SELECT key, value FROM settings WHERE key IN ('auction_test_mode', 'auction_commission')"
      )
      const isTest = (settings.find(s => s.key === 'auction_test_mode')?.value || '1') === '1'
      const commissionPercent = parseFloat(settings.find(s => s.key === 'auction_commission')?.value || '10')

      if (isTest || auction.is_test) {
        // TEST MODE: just mark as completed with top bidder, no real transfers
        const topBid = allBids[0]
        await client.query(
          "UPDATE ref_auctions SET status = 'completed', winner_id = $1, current_price = $2 WHERE id = $3",
          [topBid.bidder_id, parseFloat(topBid.amount), auction.id]
        )
        await client.query('COMMIT')
        console.log(`🏛 [TEST] Auction #${auction.id} completed → winner user#${topBid.bidder_id} for ${topBid.amount} TON`)
        await notifyAuctionEnd(auction, topBid.bidder_id, parseFloat(topBid.amount), 0, true)
        continue
      }

      // PRODUCTION MODE: funds are already locked on bid
      // Find a winning bidder (iterate through bids, deduplicate by user — take highest per user)
      const seenUsers = new Set()
      const uniqueBids = []
      for (const bid of allBids) {
        if (!seenUsers.has(bid.bidder_id)) {
          seenUsers.add(bid.bidder_id)
          uniqueBids.push(bid)
        }
      }

      let winnerId = null
      let finalPrice = 0
      let winnerBid = null

      // The top bidder per user already has funds locked
      // Just pick the first one (highest bid) — funds are locked
      for (const bid of uniqueBids) {
        // Verify funds are still locked (balance was decremented on bid)
        const { rows: [bidder] } = await client.query(
          'SELECT balance_ton FROM users WHERE id = $1 FOR UPDATE',
          [bid.bidder_id]
        )
        // Funds should already be locked, so we just accept the winner
        winnerId = bid.bidder_id
        finalPrice = parseFloat(bid.amount)
        winnerBid = bid
        break
      }

      if (!winnerId) {
        // All bids invalid — cancel
        await client.query(
          "UPDATE ref_auctions SET status = 'cancelled' WHERE id = $1",
          [auction.id]
        )
        await client.query('COMMIT')
        console.log(`🏛 Auction #${auction.id} cancelled (no valid winner)`)
        continue
      }

      const commission = finalPrice * commissionPercent / 100
      const sellerPayout = finalPrice - commission

      // Pay seller (from locked funds)
      await client.query(
        'UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2',
        [sellerPayout, auction.seller_id]
      )
      await client.query(
        "INSERT INTO transactions (user_id, type, amount, label) VALUES ($1, 'auction_sell', $2, $3)",
        [auction.seller_id, sellerPayout, `🏛 Продажа реферала на аукционе #${auction.id} (−${commissionPercent}% комиссии)`]
      )

      // Record winner transaction (funds already deducted on bid)
      await client.query(
        "INSERT INTO transactions (user_id, type, amount, label) VALUES ($1, 'auction_buy', $2, $3)",
        [winnerId, -finalPrice, `🏛 Покупка реферала на аукционе #${auction.id}`]
      )

      // Platform commission transaction
      if (commission > 0) {
        await client.query(
          "INSERT INTO transactions (user_id, type, amount, label) VALUES ($1, 'auction_fee', $2, $3)",
          [auction.seller_id, -commission, `🏛 Комиссия аукциона #${auction.id} (${commissionPercent}%)`]
        )
      }

      // Refund all non-winning bidders (their funds were locked too)
      for (const bid of uniqueBids) {
        if (bid.bidder_id !== winnerId) {
          await client.query(
            'UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2',
            [parseFloat(bid.amount), bid.bidder_id]
          )
        }
      }

      // Transfer referral ownership
      await client.query(
        'UPDATE referrals SET referrer_id = $1 WHERE id = $2',
        [winnerId, auction.referral_id]
      )

      // Update referred_by on the referred user
      const { rows: [winnerUser] } = await client.query(
        'SELECT telegram_id FROM users WHERE id = $1', [winnerId]
      )
      if (winnerUser) {
        await client.query(
          'UPDATE users SET referred_by = $1 WHERE id = $2',
          [winnerUser.telegram_id, auction.referred_user_id]
        )
      }

      // Update referral counts
      await client.query(
        'UPDATE users SET referral_count = referral_count - 1 WHERE id = $1 AND referral_count > 0',
        [auction.seller_id]
      )
      await client.query(
        'UPDATE users SET referral_count = referral_count + 1 WHERE id = $1',
        [winnerId]
      )

      // Mark auction as completed
      await client.query(
        "UPDATE ref_auctions SET status = 'completed', winner_id = $1, current_price = $2 WHERE id = $3",
        [winnerId, finalPrice, auction.id]
      )

      await client.query('COMMIT')
      console.log(`🏛 Auction #${auction.id} completed → winner user#${winnerId} for ${finalPrice} TON (seller gets ${sellerPayout})`)

      // Notify seller & winner (production)
      await notifyAuctionEnd(auction, winnerId, finalPrice, sellerPayout, false)

    } catch (e) {
      await client.query('ROLLBACK')
      console.error(`🏛 Auction #${auction.id} processing error:`, e.message)
    } finally {
      client.release()
    }
  }
}

async function notifyAuctionEnd(auction, winnerId, finalPrice, sellerPayout, isTest) {
  try {
    const bot = getBot()
    if (!bot) return

    const { rows: [seller] } = await pool.query('SELECT telegram_id FROM users WHERE id = $1', [auction.seller_id])
    const { rows: [winner] } = await pool.query('SELECT telegram_id, username, first_name FROM users WHERE id = $1', [winnerId])
    const { rows: [refUser] } = await pool.query('SELECT username, first_name FROM users WHERE id = $1', [auction.referred_user_id])

    const refName = refUser?.username ? `@${refUser.username}` : refUser?.first_name || 'Реферал'
    const winnerName = winner?.username ? `@${winner.username}` : winner?.first_name || 'Пользователь'
    const testLabel = isTest ? '🔬 [ТЕСТ] ' : ''

    // Notify seller
    if (seller) {
      const payoutLine = isTest
        ? `💰 Цена: <b>${finalPrice.toFixed(4)} TON</b> (тестовый режим)\n`
        : `💰 Цена: <b>${finalPrice.toFixed(4)} TON</b>\n💵 Ваш доход: <b>${sellerPayout.toFixed(4)} TON</b>\n`

      bot.sendMessage(seller.telegram_id,
        `🏛 ${testLabel}<b>Ваш реферал продан!</b>\n\n` +
        `👤 Реферал: <b>${refName}</b>\n` +
        `🏆 Победитель: ${winnerName}\n` +
        payoutLine +
        `📋 Лот #${auction.id}`,
        { parse_mode: 'HTML' }
      ).catch(() => {})
    }

    // Notify winner
    if (winner) {
      bot.sendMessage(winner.telegram_id,
        `🏛 ${testLabel}<b>Вы выиграли аукцион!</b>\n\n` +
        `👤 Реферал: <b>${refName}</b>\n` +
        `💰 Цена: <b>${finalPrice.toFixed(4)} TON</b>\n` +
        `📋 Лот #${auction.id}\n\n` +
        (isTest ? `🔬 Тестовый режим — реферал не переносится` : `✅ Реферал теперь ваш!`),
        { parse_mode: 'HTML' }
      ).catch(() => {})
    }
  } catch (e) {
    console.error('Auction notification error:', e.message)
  }
}
