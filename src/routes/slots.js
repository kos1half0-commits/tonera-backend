import { Router } from 'express'
import pool from '../db/index.js'
import { ADMIN_TG_ID } from '../config.js'
import { getBot } from '../bot.js'

const router = Router()

const SYMBOLS = [
  { icon: '🍋', mult: 2,   weight: 30 },
  { icon: '🍒', mult: 3,   weight: 25 },
  { icon: '🍇', mult: 4,   weight: 20 },
  { icon: '🔔', mult: 6,   weight: 12 },
  { icon: '💎', mult: 15,  weight: 8  },
  { icon: '⭐', mult: 25,  weight: 4  },
  { icon: '💰', mult: 100, weight: 1  },
]

function spinReel() {
  const total = SYMBOLS.reduce((s, sym) => s + sym.weight, 0)
  let rand = Math.random() * total
  for (const sym of SYMBOLS) {
    rand -= sym.weight
    if (rand <= 0) return sym
  }
  return SYMBOLS[0]
}

router.get('/info', async (req, res) => {
  try {
    const { rows } = await pool.query(
  "SELECT key, value FROM settings WHERE key IN ('slots_enabled','slots_min_bet','slots_bank','slots_win_chance')"
    )
    const d = { slots_enabled: '1', slots_min_bet: '0.01', slots_bank: '0' }
    rows.forEach(r => { d[r.key] = r.value })
    res.json(d)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/spin', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount } = req.body
    const betAmount = parseFloat(amount)

    const { rows: settings } = await client.query(
  "SELECT key, value FROM settings WHERE key IN ('slots_enabled','slots_min_bet','slots_bank','slots_win_chance')"
    )
    const enabled = settings.find(s => s.key === 'slots_enabled')?.value
    const bank = parseFloat(settings.find(s => s.key === 'slots_bank')?.value || 0)
    const winChance = parseFloat(settings.find(s => s.key === 'slots_win_chance')?.value || 45)
    if (enabled !== '1' && enabled !== '3') return res.status(400).json({ error: 'Слоты недоступны' })

    await client.query('BEGIN')
    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1 FOR UPDATE', [tgId])
    if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }) }
    if (parseFloat(user.balance_ton) < betAmount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Недостаточно средств' }) }

    await client.query('UPDATE users SET balance_ton=balance_ton-$1 WHERE id=$2', [betAmount, user.id])

    // Ставка идёт в банк
    await client.query("UPDATE settings SET value=CAST(CAST(value AS DECIMAL)+$1 AS TEXT) WHERE key='slots_bank'", [betAmount])

    const s1 = spinReel(), s2 = spinReel(), s3 = spinReel()
    let finalSymbols = [s1.icon, s2.icon, s3.icon]
    let won = false, multiplier = 0, payout = 0

    // Применяем общий шанс победы
    const rawWin = (s1.icon === s2.icon && s2.icon === s3.icon) || (s1.icon === s2.icon || s2.icon === s3.icon || s1.icon === s3.icon)
    if (rawWin && Math.random() * 100 < winChance) {
      if (s1.icon === s2.icon && s2.icon === s3.icon) {
        won = true; multiplier = s1.mult; payout = betAmount * multiplier
      } else {
        won = true; multiplier = 2; payout = betAmount * multiplier
      }
    } else if (rawWin) {
      // Выпала выигрышная комбинация но шанс не прошёл — меняем символы чтобы разбить пару
      const loseSym = SYMBOLS.find(s => s.icon !== s1.icon && s.icon !== s2.icon && s.icon !== s3.icon)
        || SYMBOLS.find(s => s.icon !== s1.icon)
      if (loseSym) finalSymbols = [s1.icon, s2.icon, loseSym.icon]
      // Проверяем что теперь нет пар
      if (finalSymbols[0]===finalSymbols[1] || finalSymbols[1]===finalSymbols[2] || finalSymbols[0]===finalSymbols[2]) {
        // Всё ещё есть пара — меняем второй
        const loseSym2 = SYMBOLS.find(s => s.icon !== finalSymbols[0] && s.icon !== finalSymbols[2])
        if (loseSym2) finalSymbols[1] = loseSym2.icon
      }
    }

    const symbols = finalSymbols
    const newBank = bank + betAmount
    if (won && payout > newBank) {
      // Банк пустой — возвращаем ставку
      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [betAmount, user.id])
      await client.query("UPDATE settings SET value=CAST(GREATEST(CAST(value AS DECIMAL)-$1,0) AS TEXT) WHERE key='slots_bank'", [betAmount])
      await client.query('COMMIT')
      // Отключаем слоты
      await pool.query("UPDATE settings SET value='2' WHERE key='slots_enabled'")
      try {
        const bot = getBot()
        if (bot) await bot.sendMessage(ADMIN_TG_ID, '⚠️ <b>БАНК СЛОТОВ ПУСТОЙ</b>\n\nСлоты переведены в тех. обслуживание.', { parse_mode: 'HTML' })
      } catch {}
      return res.status(400).json({ error: 'Банк слотов пуст', disabled: true })
    }

    if (won) {
      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [payout, user.id])
      await client.query("UPDATE settings SET value=CAST(GREATEST(CAST(value AS DECIMAL)-$1,0) AS TEXT) WHERE key='slots_bank'", [payout])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'slots',$2,$3)",
        [user.id, payout - betAmount, `🎰 Слоты x${multiplier}: +${(payout-betAmount).toFixed(4)} TON`])
    } else {
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'slots',$2,$3)",
        [user.id, -betAmount, `🎰 Слоты: проигрыш -${betAmount} TON`])
    }

    await client.query('COMMIT')
    res.json({ ok: true, symbols, won, payout, multiplier })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

router.get('/history', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows } = await pool.query(
      `SELECT t.* FROM transactions t JOIN users u ON t.user_id=u.id
       WHERE u.telegram_id=$1 AND t.type='slots'
       ORDER BY t.created_at DESC LIMIT 20`,
      [tgId]
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router