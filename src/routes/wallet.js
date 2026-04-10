import { Router } from 'express'
import pool from '../db/index.js'

const router = Router()

// GET /api/wallet/transactions
router.get('/transactions', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows } = await pool.query(
      `SELECT t.*
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       WHERE u.telegram_id = $1
         AND t.type NOT IN ('fee','spin','miner_buy','miner_collect','miner_electricity','miner_upgrade')
       ORDER BY t.created_at DESC
       LIMIT 100`,
      [tgId]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/user/me
router.get('/me', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1', [tgId]
    )
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json(user)
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
