import { Router } from 'express'
import pool from '../db/index.js'

const router = Router()
const WELCOME_BONUS = 0.1

router.get('/status', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query(
      'SELECT welcome_bonus_claimed FROM users WHERE telegram_id=$1', [tgId]
    )
    res.json({ claimed: user?.welcome_bonus_claimed || false, amount: WELCOME_BONUS })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/claim', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (user.welcome_bonus_claimed) return res.status(400).json({ error: 'Already claimed' })

    // Зачисляем bonus_balance
    await client.query(
      'UPDATE users SET bonus_balance=bonus_balance+$1, welcome_bonus_claimed=true WHERE id=$2',
      [WELCOME_BONUS, user.id]
    )

    // Добавляем к существующему стейку или создаём новый
    const { rows: [existingStake] } = await client.query(
      "SELECT * FROM stakes WHERE user_id=$1 AND status='active' FOR UPDATE",
      [user.id]
    )
    let stake
    if (existingStake) {
      const msPerDay = 1000 * 60 * 60 * 24
      const elapsedMs = Date.now() - new Date(existingStake.started_at).getTime()
      const currentEarned = parseFloat(existingStake.earned || 0) + parseFloat(existingStake.amount) * 0.01 / msPerDay * elapsedMs
      const { rows: [s] } = await client.query(
        `UPDATE stakes SET amount=amount+$1, earned=$2, started_at=NOW() WHERE id=$3 RETURNING *`,
        [WELCOME_BONUS, currentEarned, existingStake.id]
      )
      stake = s
    } else {
      const { rows: [s] } = await client.query(
        `INSERT INTO stakes (user_id, amount, started_at, status)
         VALUES ($1, $2, NOW(), 'active') RETURNING *`,
        [user.id, WELCOME_BONUS]
      )
      stake = s
    }

    // Лог
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1,'bonus',$2,'Приветственный бонус на стейкинг')`,
      [user.id, WELCOME_BONUS]
    )

    await client.query('COMMIT')
    res.json({ ok: true, amount: WELCOME_BONUS, stake })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

export default router
