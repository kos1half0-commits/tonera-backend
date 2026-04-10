import { Router } from 'express'
import pool from '../db/index.js'
import { ADMIN_TG_ID } from '../config.js'

const router = Router()

// GET /api/trading/info
router.get('/info', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('trading_enabled','trading_multiplier','trading_bank','trading_profit_fee','trading_commission')"
    )
    const d = { trading_enabled:'1', trading_multiplier:'90', trading_bank:'0', trading_profit_fee:'10', trading_commission:'5' }
    rows.forEach(r => { d[r.key] = r.value })
    res.json(d)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/trading/bet — открыть позицию (ставка списывается, сохраняется в БД)
router.post('/bet', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount, direction, duration } = req.body
    if (!amount || !direction || !duration) return res.status(400).json({ error: 'Invalid params' })
    if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: 'Direction must be up or down' })

    const betAmount = parseFloat(amount)
    if (betAmount <= 0) return res.status(400).json({ error: 'Invalid amount' })

    // Валидация duration (в секундах)
    const allowedDurations = [60, 120, 180, 300]
    if (!allowedDurations.includes(parseInt(duration))) return res.status(400).json({ error: 'Invalid duration' })

    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1 FOR UPDATE', [tgId])
    if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }) }

    const { rows: settings } = await client.query(
      "SELECT key, value FROM settings WHERE key IN ('trading_enabled','trading_commission')"
    )
    const enabledStatus = settings.find(s => s.key === 'trading_enabled')?.value || '1'
    if (enabledStatus !== '1') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Трейдинг недоступен', disabled: true })
    }

    if (parseFloat(user.balance_ton) < betAmount) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Недостаточно средств' })
    }

    // Авто-закрытие просроченных ставок (если предыдущая сбросилась из-за ошибки)
    const { rows: openBets } = await client.query(
      "SELECT * FROM transactions WHERE user_id=$1 AND type='trading_bet' AND status='open'",
      [user.id]
    )
    for (const ob of openBets) {
      const parts = (ob.label || '').split('|')
      const betEnd = new Date(parts[1])
      if (isNaN(betEnd.getTime()) || Date.now() > betEnd.getTime() + 10000) {
        // Ставка просрочена — возвращаем деньги
        const refundAmt = Math.abs(parseFloat(ob.amount))
        await client.query("UPDATE transactions SET status='closed' WHERE id=$1", [ob.id])
        await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [refundAmt, user.id])
        await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading',$2,$3)",
          [user.id, refundAmt, `🔄 refund:${refundAmt.toFixed(4)}:expired`])
      }
    }

    // Проверяем что у юзера нет активной (непросроченной) ставки
    const { rows: [existingBet] } = await client.query(
      "SELECT id FROM transactions WHERE user_id=$1 AND type='trading_bet' AND status='open'",
      [user.id]
    )
    if (existingBet) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'У вас уже есть открытая ставка' })
    }

    // Списываем ставку
    await client.query('UPDATE users SET balance_ton=balance_ton-$1 WHERE id=$2', [betAmount, user.id])

    // Получаем текущую цену TON с сервера
    let startPrice = 0
    // Попытка 1: Binance
    try {
      const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { signal: AbortSignal.timeout(5000) })
      const d = await r.json()
      startPrice = parseFloat(d.price)
    } catch {}
    // Попытка 2: CoinGecko
    if (!startPrice || startPrice <= 0) {
      try {
        const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { signal: AbortSignal.timeout(5000) })
        const d = await r.json()
        startPrice = parseFloat(d['bitcoin']?.usd)
      } catch {}
    }
    // Попытка 3: клиентская цена (если API недоступны)
    if (!startPrice || startPrice <= 0) {
      startPrice = parseFloat(req.body.startPrice)
    }
    if (!startPrice || startPrice <= 0) {
      await client.query('ROLLBACK')
      return res.status(500).json({ error: 'Ошибка получения цены' })
    }

    // Сохраняем ставку с серверной ценой
    const endTime = new Date(Date.now() + parseInt(duration) * 1000)
    await client.query(
      "INSERT INTO transactions (user_id, type, amount, label, status) VALUES ($1, 'trading_bet', $2, $3, 'open')",
      [user.id, -betAmount, `${direction}|${endTime.toISOString()}|${startPrice}`]
    )

    await client.query('COMMIT')
    res.json({ ok: true, endTime: endTime.toISOString(), startPrice })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// POST /api/trading/result — закрыть ставку (сервер определяет победу по переданной цене)
router.post('/result', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id

    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1 FOR UPDATE', [tgId])
    if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }) }

    // Находим открытую ставку с блокировкой
    const { rows: [betTx] } = await client.query(
      "SELECT * FROM transactions WHERE user_id=$1 AND type='trading_bet' AND status='open' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [user.id]
    )
    if (!betTx) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Нет открытой ставки' }) }

    // Парсим direction, endTime и startPrice из label
    const parts = (betTx.label || '').split('|')
    const direction = parts[0]
    const endTime = new Date(parts[1])
    const startPrice = parseFloat(parts[2])

    // Проверяем что время ставки истекло (с погрешностью 3 сек)
    if (Date.now() < endTime.getTime() - 3000) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Ставка ещё активна' })
    }

    // Получаем текущую цену TON с сервера
    let endPrice = 0
    try {
      const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { signal: AbortSignal.timeout(5000) })
      const d = await r.json()
      endPrice = parseFloat(d.price)
    } catch {}
    if (!endPrice || endPrice <= 0) {
      try {
        const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { signal: AbortSignal.timeout(5000) })
        const d = await r.json()
        endPrice = parseFloat(d['bitcoin']?.usd)
      } catch {}
    }
    // Fallback: клиентская цена
    if (!endPrice || endPrice <= 0) {
      endPrice = parseFloat(req.body.endPrice)
    }
    if (!endPrice || endPrice <= 0) {
      // Все API недоступны — возвращаем ставку
      const betAmt = Math.abs(parseFloat(betTx.amount))
      await client.query("UPDATE transactions SET status='closed' WHERE id=$1", [betTx.id])
      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [betAmt, user.id])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading',$2,$3)",
        [user.id, betAmt, `🔄 refund:${betAmt.toFixed(4)}:api_error`])
      await client.query('COMMIT')
      return res.json({ ok: true, won: null, profit: betAmt })
    }

    const betAmount = Math.abs(parseFloat(betTx.amount))

    // Закрываем ставку
    await client.query("UPDATE transactions SET status='closed' WHERE id=$1", [betTx.id])

    // Сервер определяет победу
    const priceDiff = parseFloat(endPrice) - parseFloat(startPrice)
    const relDiff = Math.abs(priceDiff) / parseFloat(startPrice)

    let won = null
    if (relDiff < 0.0001) {
      won = null // слишком маленькая разница — возврат (0.01%)
    } else {
      won = direction === 'up' ? priceDiff > 0 : priceDiff < 0
    }

    const { rows: resultSettings } = await client.query(
      "SELECT key, value FROM settings WHERE key IN ('trading_enabled','trading_multiplier','trading_bank','trading_profit_fee','trading_commission')"
    )
    const pct = parseFloat(resultSettings.find(s => s.key === 'trading_multiplier')?.value || 90)
    const multiplier = pct > 10 ? 1 + pct / 100 : pct
    const profitFeePct = parseFloat(resultSettings.find(s => s.key === 'trading_profit_fee')?.value || 10) / 100
    const commissionPct = parseFloat(resultSettings.find(s => s.key === 'trading_commission')?.value || 5) / 100

    // Комиссия с каждой ставки
    const commission = betAmount * commissionPct
    const betNet = betAmount - commission

    // Комиссия делится: % прибыли — админу, остаток — в банк
    const commissionProfit = commission * profitFeePct
    const commissionToBank = commission - commissionProfit

    const { rows: [admin] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [ADMIN_TG_ID])

    // Комиссия в банк
    await client.query("UPDATE settings SET value=CAST(CAST(value AS DECIMAL)+$1 AS TEXT) WHERE key='trading_bank'", [commissionToBank])
    // Прибыль с комиссии — админу
    if (admin && commissionProfit > 0) {
      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [commissionProfit, admin.id])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading_profit',$2,'Комиссия трейдинг')", [admin.id, commissionProfit])
    }

    let profit = 0

    if (won === null) {
      // Возврат — возвращаем betNet (без комиссии)
      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [betNet, user.id])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading',$2,$3)",
        [user.id, betNet, `🔄 refund:${betNet.toFixed(4)}`])
      profit = betNet
    } else if (won) {
      // Выигрыш — проверяем банк
      profit = betAmount * multiplier
      const { rows: [bankCheck] } = await client.query("SELECT value FROM settings WHERE key='trading_bank'")
      const bankNow = parseFloat(bankCheck?.value || 0)
      if (bankNow < profit) {
        // Возвращаем ПОЛНУЮ ставку (включая комиссию)
        await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [betAmount, user.id])
        // Откатываем комиссию
        await client.query("UPDATE settings SET value=CAST(GREATEST(CAST(value AS DECIMAL)-$1,0) AS TEXT) WHERE key='trading_bank'", [commissionToBank])
        if (admin && commissionProfit > 0) {
          await client.query('UPDATE users SET balance_ton=balance_ton-$1 WHERE id=$2', [commissionProfit, admin.id])
        }
        await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading',$2,$3)",
          [user.id, betAmount, `🔄 refund:${betAmount.toFixed(4)}:tech`])
        await client.query('COMMIT')
        await pool.query("UPDATE settings SET value='2' WHERE key='trading_enabled'")
        try {
          const { getBot } = await import('../bot.js')
          const bot = getBot()
          if (bot) await bot.sendMessage(ADMIN_TG_ID,
            `⚠️ <b>БАНК ТРЕЙДИНГА ПУСТОЙ</b>\n\nТрейдинг автоматически отключён.\nПополните банк и включите вручную.`,
            { parse_mode: 'HTML' }
          )
        } catch {}
        return res.status(400).json({ error: 'Трейдинг недоступен — банк пуст', disabled: true })
      }
      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [profit, user.id])
      await client.query("UPDATE settings SET value=CAST(GREATEST(CAST(value AS DECIMAL)-$1,0) AS TEXT) WHERE key='trading_bank'", [profit])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading',$2,$3)",
        [user.id, profit, `📈 win:${profit.toFixed(4)}:bet:${betAmount.toFixed(4)}`])

      // Проверяем банк после выигрыша
      const { rows: [bankRow] } = await client.query("SELECT value FROM settings WHERE key='trading_bank'")
      if (parseFloat(bankRow?.value || 0) <= 0) {
        await client.query('COMMIT')
        await pool.query("UPDATE settings SET value='2' WHERE key='trading_enabled'")
        try {
          const { getBot } = await import('../bot.js')
          const bot = getBot()
          if (bot) await bot.sendMessage(ADMIN_TG_ID,
            `⚠️ <b>БАНК ТРЕЙДИНГА ПУСТОЙ</b>\n\nТрейдинг автоматически отключён.\nПополните банк и включите вручную в настройках.`,
            { parse_mode: 'HTML' }
          )
        } catch {}
        return res.json({ ok: true, won, profit })
      }
    } else {
      // Проигрыш — betNet идёт в банк
      await client.query("UPDATE settings SET value=CAST(CAST(value AS DECIMAL)+$1 AS TEXT) WHERE key='trading_bank'", [betNet])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading',$2,$3)",
        [user.id, -betAmount, `📉 lose:${betAmount.toFixed(4)}`])
    }

    await client.query('COMMIT')
    res.json({ ok: true, won, profit })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// GET /api/trading/history
router.get('/history', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows } = await pool.query(
      `SELECT t.* FROM transactions t JOIN users u ON t.user_id=u.id
       WHERE u.telegram_id=$1 AND t.type='trading'
       ORDER BY t.created_at DESC LIMIT 20`,
      [tgId]
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
