import { Router } from 'express'
import pool from '../db/index.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const tgId = req.telegramUser.id

    const { rows: [user] } = await pool.query('SELECT id, is_admin FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.json({ referrals: [], earned: 0, from_tasks: 0, from_deposits: 0 })

    // Список рефералов + активность + задания (один запрос)
    const { rows } = await pool.query(`
      SELECT 
        u2.username, u2.first_name, u2.id as ref_user_id, u2.telegram_id as ref_tg_id,
        r.created_at, r.id as referral_id,
        COALESCE(act.tx_count, 0)::int as tx_count_30d,
        act.last_active,
        COALESCE(tasks.cnt, 0)::int as tasks_completed
      FROM referrals r
      JOIN users u2 ON r.referred_id = u2.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) as tx_count, MAX(created_at) as last_active
        FROM transactions
        WHERE user_id = u2.id AND created_at > NOW() - INTERVAL '30 days'
      ) act ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) as cnt FROM user_tasks WHERE user_id = u2.id
      ) tasks ON true
      WHERE r.referrer_id = $1
      ORDER BY r.created_at DESC
    `, [user.id])

    // Регистрационный бонус
    const { rows: [regSetting] } = await pool.query(
      "SELECT value FROM settings WHERE key = 'ref_register_bonus'"
    )
    const regBonus = parseFloat(regSetting?.value || 0.001)

    // Auction eligibility settings
    const { rows: auctionSettings } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('auction_min_tasks','auction_min_activity_days')"
    )
    const aSet = {}
    auctionSettings.forEach(r => aSet[r.key] = r.value)
    const auctionMinTasks = parseInt(aSet.auction_min_tasks || '50')
    const auctionMinDays = parseInt(aSet.auction_min_activity_days || '7')

    // Формируем рефералов
    const now = new Date()
    const referrals = rows.map(r => {
      const lastActive = r.last_active ? new Date(r.last_active) : null
      const daysSinceActive = lastActive ? Math.floor((now - lastActive) / 86400000) : 999
      const isActiveRecently = daysSinceActive <= auctionMinDays
      const hasEnoughTasks = r.tasks_completed >= auctionMinTasks
      const adminBypass = user.is_admin === true
      return {
        ...r,
        earned: regBonus,
        is_active: r.tx_count_30d > 0,
        tasks_completed: r.tasks_completed,
        auction_eligible: adminBypass || (isActiveRecently && hasEnoughTasks),
        auction_reason: adminBypass ? null : (
          !hasEnoughTasks
            ? `Мин. ${auctionMinTasks} заданий (сейчас: ${r.tasks_completed})`
            : !isActiveRecently
              ? `Неактивен ${daysSinceActive}д (макс. ${auctionMinDays}д)`
              : null
        )
      }
    })

    // Реальные суммы из транзакций
    const { rows: totals } = await pool.query(`
      SELECT 
        COALESCE(SUM(amount) FILTER (WHERE type IN ('ref_task','ref_deposit','ref_bonus')), 0) as total_earned,
        COALESCE(SUM(amount) FILTER (WHERE type = 'ref_task'), 0) as from_tasks,
        COALESCE(SUM(amount) FILTER (WHERE type = 'ref_deposit'), 0) as from_deposits
      FROM transactions
      WHERE user_id = $1 AND amount > 0
    `, [user.id])

    res.json({
      referrals,
      earned: parseFloat(totals[0]?.total_earned || 0),
      from_tasks: parseFloat(totals[0]?.from_tasks || 0),
      from_deposits: parseFloat(totals[0]?.from_deposits || 0),
      auction_min_tasks: auctionMinTasks,
      auction_min_activity_days: auctionMinDays,
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/apply', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { ref_code } = req.body
    if (!ref_code) return res.status(400).json({ error: 'No ref code' })

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    const { rows: [referrer] } = await client.query('SELECT * FROM users WHERE ref_code = $1', [ref_code])
    if (!referrer) return res.status(404).json({ error: 'Invalid ref code' })
    if (referrer.telegram_id === tgId) return res.status(400).json({ error: 'Self-referral not allowed' })

    const { rows: [existing] } = await client.query('SELECT id FROM referrals WHERE referred_id = $1', [user.id])
    if (existing) return res.status(400).json({ error: 'Already referred' })

    await client.query('BEGIN')
    await client.query('INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2)', [referrer.id, user.id])
    await client.query('UPDATE users SET referral_count = referral_count + 1 WHERE id = $1', [referrer.id])
    await client.query('UPDATE users SET referred_by = $1 WHERE id = $2', [referrer.telegram_id, user.id])

    const { rows: [setting] } = await client.query("SELECT value FROM settings WHERE key = 'ref_register_bonus'")
    const bonus = parseFloat(setting?.value || 0.001)
    if (bonus > 0) {
      await client.query('UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2', [bonus, referrer.id])
      await client.query(
        "INSERT INTO transactions (user_id, type, amount, label) VALUES ($1,'ref_bonus',$2,$3)",
        [referrer.id, bonus, `Реф. бонус за регистрацию`]
      )
    }

    await client.query('COMMIT')
    res.json({ ok: true })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

export default router