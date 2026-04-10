import { Router } from 'express'
import pool from '../db/index.js'
import { ADMIN_TG_ID } from '../config.js'

const router = Router()

async function adminOnly(req, res, next) {
  const tgId = Number(req.telegramUser?.id)
  if (tgId === ADMIN_TG_ID) return next()
  // Проверяем таблицу дополнительных админов
  try {
    const { rows } = await pool.query('SELECT id FROM admins WHERE telegram_id=$1', [tgId])
    if (rows.length > 0) return next()
  } catch {}
  return res.status(403).json({ error: 'Forbidden' })
}

router.get('/settings', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM settings ORDER BY key')
    const s = {}
    rows.forEach(r => s[r.key] = r.value)
    res.json(s)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/settings', adminOnly, async (req, res) => {
  try {
    const { key, value } = req.body
    if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' })
    await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, String(value)])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/stats', adminOnly, async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM users WHERE is_blocked=true) as blocked_users,
        (SELECT COUNT(*) FROM users WHERE created_at >= CURRENT_DATE) as today_users,
        (SELECT COUNT(*) FROM users WHERE created_at >= CURRENT_DATE - INTERVAL '7 days') as week_users,
        (SELECT COUNT(*) FROM stakes WHERE status='active') as active_stakes,
        (SELECT COALESCE(SUM(amount),0) FROM stakes WHERE status='active') as total_staked,
        (SELECT COUNT(*) FROM referrals) as total_referrals,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='ref_bonus') as ref_bonuses_paid,
        (SELECT COUNT(*) FROM users WHERE referred_by IS NOT NULL) as users_with_referrer,
        (SELECT COUNT(*) FROM users WHERE referred_by IS NULL) as users_without_referrer,
        (SELECT COUNT(*) FROM user_tasks) as tasks_completed,
        (SELECT COUNT(*) FROM tasks WHERE active=true) as active_tasks,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='fee' AND label='Комиссия стейкинга') as staking_fee_earned,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='fee' AND label NOT LIKE '%стейкинга%') as task_fee_earned,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='deposit') as total_deposited,
        (SELECT ABS(COALESCE(SUM(amount),0)) FROM transactions WHERE type='withdraw') as total_withdrawn,
        (SELECT COUNT(*) FROM transactions WHERE type='spin_result') as total_spins,
        (SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) - SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) FROM transactions WHERE type='spin_result') as spin_revenue,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='spin_profit') as spin_profit,
        (SELECT value FROM settings WHERE key='spin_jackpot') as current_jackpot,
        (SELECT value FROM settings WHERE key='spin_pool') as spin_pool,
        (SELECT COUNT(*) FROM transactions WHERE type='slots') as slots_total,
        (SELECT COUNT(*) FROM transactions WHERE type='slots' AND amount > 0) as slots_wins,
        (SELECT value FROM settings WHERE key='slots_bank') as slots_bank,
        (SELECT COUNT(*) FROM transactions WHERE type='trading') as trading_total,
        (SELECT COUNT(*) FROM transactions WHERE type='trading' AND amount > 0 AND label LIKE '📈%') as trading_wins,
        (SELECT COUNT(*) FROM transactions WHERE type='trading' AND amount < 0) as trading_loses,
        (SELECT COUNT(*) FROM transactions WHERE type='trading' AND label LIKE '🔄%') as trading_refunds,
        (SELECT value FROM settings WHERE key='trading_bank') as trading_bank,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='trading_profit') as trading_profit
    `)

    // Mining stats (separate query to handle table not existing gracefully)
    let miningStats = { miner_active_contracts: 0, miner_total_users: 0, miner_total_hashrate: 0, miner_total_revenue: 0, miner_total_earned: 0, miner_pending_withdrawals: 0, miner_paid_amount: 0 }
    try {
      const { rows: [ms] } = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM miner_contracts WHERE status='active' AND expires_at > NOW()) as miner_active_contracts,
          (SELECT COUNT(DISTINCT user_id) FROM miner_contracts WHERE status='active') as miner_total_users,
          (SELECT COALESCE(SUM(hashrate),0) FROM miner_contracts WHERE status='active' AND expires_at > NOW()) as miner_total_hashrate,
          (SELECT COALESCE(SUM(price_paid),0) FROM miner_contracts) as miner_total_revenue,
          (SELECT COALESCE(SUM(earned),0) FROM miner_contracts) as miner_total_earned,
          (SELECT COUNT(*) FROM miner_withdrawals WHERE status='pending') as miner_pending_withdrawals,
          (SELECT COALESCE(SUM(amount),0) FROM miner_withdrawals WHERE status='completed') as miner_paid_amount
      `)
      miningStats = ms
    } catch {}

    // Ads stats
    let adsStats = { ads_active: 0, ads_total: 0, ad_orders_pending: 0, ad_orders_total: 0 }
    try {
      const { rows: [as2] } = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM ads WHERE active=true) as ads_active,
          (SELECT COUNT(*) FROM ads) as ads_total,
          (SELECT COUNT(*) FROM ad_orders WHERE status='pending') as ad_orders_pending,
          (SELECT COUNT(*) FROM ad_orders) as ad_orders_total
      `)
      adsStats = as2
    } catch {}

    // Auction stats
    let auctionStats = { auction_total: 0, auction_active: 0, auction_completed: 0, auction_total_bids: 0, auction_volume: 0 }
    try {
      const { rows: [au] } = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM ref_auctions) as auction_total,
          (SELECT COUNT(*) FROM ref_auctions WHERE status='active') as auction_active,
          (SELECT COUNT(*) FROM ref_auctions WHERE status='completed') as auction_completed,
          (SELECT COUNT(*) FROM ref_auction_bids) as auction_total_bids,
          (SELECT COALESCE(SUM(current_price),0) FROM ref_auctions WHERE status='completed') as auction_volume
      `)
      auctionStats = au
    } catch {}

    // Partnership stats
    let partnerStats = { partners_total: 0, partners_approved: 0, partners_pending: 0, partners_rejected: 0 }
    try {
      const { rows: [ps] } = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM partnerships) as partners_total,
          (SELECT COUNT(*) FROM partnerships WHERE status='approved') as partners_approved,
          (SELECT COUNT(*) FROM partnerships WHERE status='pending') as partners_pending,
          (SELECT COUNT(*) FROM partnerships WHERE status='rejected') as partners_rejected
      `)
      partnerStats = ps
    } catch {}

    // Promo stats
    let promoStats = { promo_total: 0, promo_active: 0, promo_total_uses: 0, promo_total_amount: 0 }
    try {
      const { rows: [pr] } = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM promo_codes) as promo_total,
          (SELECT COUNT(*) FROM promo_codes WHERE active=true) as promo_active,
          (SELECT COALESCE(SUM(uses),0) FROM promo_codes) as promo_total_uses,
          (SELECT COALESCE(SUM(p.amount * p.uses),0) FROM promo_codes p) as promo_total_amount
      `)
      promoStats = pr
    } catch {}

    // Referral top referrers
    let refTopCount = 0
    try {
      const { rows: [tc] } = await pool.query(`SELECT COUNT(*) as cnt FROM users WHERE referral_count > 0`)
      refTopCount = parseInt(tc.cnt)
    } catch {}

    res.json({ ...stats, ...miningStats, ...adsStats, ...auctionStats, ...partnerStats, ...promoStats, ref_active_referrers: refTopCount })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/admin/activity — real-time transaction feed
router.get('/activity', adminOnly, async (req, res) => {
  try {
    const after = req.query.after || null // ISO timestamp for polling
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)

    let query, params
    if (after) {
      query = `
        SELECT t.id, t.user_id, t.type, t.amount, t.label, t.status, t.created_at,
               u.username, u.first_name, u.telegram_id
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        WHERE t.created_at > $1
        ORDER BY t.created_at DESC
        LIMIT $2
      `
      params = [after, limit]
    } else {
      query = `
        SELECT t.id, t.user_id, t.type, t.amount, t.label, t.status, t.created_at,
               u.username, u.first_name, u.telegram_id
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        ORDER BY t.created_at DESC
        LIMIT $1
      `
      params = [limit]
    }

    const { rows } = await pool.query(query, params)
    const { rows: [countRow] } = await pool.query('SELECT COUNT(*) FROM transactions')
    res.json({ transactions: rows, total: parseInt(countRow.count), server_time: new Date().toISOString() })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/tasks', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, u.username as creator_username, u.first_name as creator_name
       FROM tasks t
       LEFT JOIN users u ON t.creator_id = u.id
       ORDER BY t.id DESC`
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/tasks', adminOnly, async (req, res) => {
  try {
    const { type, title, reward, icon, link, channel_title, channel_photo } = req.body
    if (!title) return res.status(400).json({ error: 'title required' })
    const { rows: settings } = await pool.query(
      "SELECT key,value FROM settings WHERE key IN ('task_reward','task_ref_bonus','task_project_fee','task_price')"
    )
    const get = k => parseFloat(settings.find(s=>s.key===k)?.value || 0)
    const taskReward   = reward || get('task_reward') || 0.001
    const refBonus     = get('task_ref_bonus')   || 0.0002
    const projectFee   = get('task_project_fee') || 0.0002
    const pricePerExec = get('task_price')        || 0.002
    const { rows: [task] } = await pool.query(
      `INSERT INTO tasks (type,title,reward,icon,link,channel_title,channel_photo,active,ref_bonus,project_fee,price_per_exec)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10) RETURNING *`,
      [type||'subscribe', title, taskReward, icon||'✈️', link||null, channel_title||null, channel_photo||null, refBonus, projectFee, pricePerExec]
    )
    res.json(task)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.delete('/tasks/:id', adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM user_tasks WHERE task_id=$1', [req.params.id])
    await pool.query('DELETE FROM tasks WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/admin/users
router.get('/users', adminOnly, async (req, res) => {
  try {
    const page = parseInt(req.query.page || 1)
    const limit = 50
    const offset = (page - 1) * limit
    const search = req.query.search || ''
    const filter = req.query.filter || 'all' // all|donors|stakers

    let where = []
    let params = []
    let pi = 1

    if (search) {
      where.push(`(u.username ILIKE $${pi} OR u.first_name ILIKE $${pi} OR CAST(u.telegram_id AS TEXT) LIKE $${pi})`)
      params.push(`%${search}%`)
      pi++
    }
    if (filter === 'donors') {
      where.push(`(SELECT COALESCE(SUM(amount),0) FROM transactions WHERE user_id=u.id AND type='deposit') > 0`)
    }
    if (filter === 'stakers') {
      where.push(`(SELECT COALESCE(SUM(amount),0) FROM stakes WHERE user_id=u.id AND status='active') > 0`)
    }

    const whereStr = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const orderBy = filter === 'donors'
      ? `ORDER BY total_deposited DESC`
      : filter === 'stakers'
      ? `ORDER BY staking_amount DESC`
      : `ORDER BY u.created_at DESC`

    const r = await pool.query(
      `SELECT u.id, u.telegram_id, u.username, u.first_name, u.balance_ton, u.referral_count, u.is_blocked, u.created_at,
        COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id=u.id AND type='deposit'),0) as total_deposited,
        COALESCE((SELECT SUM(amount) FROM stakes WHERE user_id=u.id AND status='active'),0) as staking_amount
       FROM users u ${whereStr} ${orderBy} LIMIT $${pi} OFFSET $${pi+1}`,
      [...params, limit, offset]
    )
    const c = await pool.query(`SELECT COUNT(*) FROM users u ${whereStr}`, params)
    const total = parseInt(c.rows[0].count)
    res.json({ users: r.rows, total, page, pages: Math.ceil(total / limit) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/users/:id/block — заблокировать
router.post('/users/:id/block', adminOnly, async (req, res) => {
  try {
    await pool.query('UPDATE users SET is_blocked=true WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/users/:id/unblock — разблокировать
router.post('/users/:id/unblock', adminOnly, async (req, res) => {
  try {
    await pool.query('UPDATE users SET is_blocked=false WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/admin/users/:id — удалить
router.delete('/users/:id', adminOnly, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM user_tasks WHERE user_id=$1', [req.params.id])
    await client.query('DELETE FROM referrals WHERE referrer_id=$1 OR referred_id=$1', [req.params.id])
    await client.query('DELETE FROM transactions WHERE user_id=$1', [req.params.id])
    await client.query('DELETE FROM stakes WHERE user_id=$1', [req.params.id])
    await client.query('UPDATE tasks SET creator_id=NULL WHERE creator_id=$1', [req.params.id])
    await client.query('DELETE FROM users WHERE id=$1', [req.params.id])
    await client.query('COMMIT')
    res.json({ ok: true })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})


// GET /api/admin/withdrawals
router.get('/withdrawals', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, u.username, u.first_name FROM transactions t
       JOIN users u ON t.user_id = u.id
       WHERE t.type = 'withdraw'
       ORDER BY t.created_at DESC LIMIT 100`
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/withdrawals/:id/complete
router.post('/withdrawals/:id/complete', adminOnly, async (req, res) => {
  try {
    const { rows: [tx] } = await pool.query(
      "UPDATE transactions SET status='completed' WHERE id=$1 RETURNING *",
      [req.params.id]
    )
    if (tx) {
      // Уведомляем юзера
      const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id=$1', [tx.user_id])
      if (user) {
        try {
          const { getBot } = await import('../bot.js')
          const bot = getBot()
          if (bot) {
            const labelParts = (tx.label || '').split('|net:')
            const netAmt = labelParts[1] ? parseFloat(labelParts[1]).toFixed(4) : Math.abs(parseFloat(tx.amount)).toFixed(4)
            const totalAmt = Math.abs(parseFloat(tx.amount)).toFixed(4)
            const feeAmt = (Math.abs(parseFloat(tx.amount)) - parseFloat(netAmt)).toFixed(4)
            const msg = parseFloat(feeAmt) > 0
              ? `✅ <b>Вывод выполнен</b>\n\nЗапрошено: <b>${totalAmt} TON</b>\nКомиссия: <b>${feeAmt} TON</b>\nПолучите: <b>${netAmt} TON</b>`
              : `✅ <b>Вывод выполнен</b>\n\nСумма: <b>${netAmt} TON</b> отправлена на ваш кошелёк.`
            await bot.sendMessage(user.telegram_id, msg, { parse_mode: 'HTML' })
          }
        } catch (e) { console.error('Notify error:', e.message) }
      }
    }
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/withdrawals/:id/cancel — отменить вывод и вернуть средства
router.post('/withdrawals/:id/cancel', adminOnly, async (req, res) => {
  const client = await pool.connect()
  try {
    const { refund_amount } = req.body
    const { rows: [tx] } = await client.query(
      "SELECT * FROM transactions WHERE id=$1 AND type='withdraw'", [req.params.id]
    )
    if (!tx) return res.status(404).json({ error: 'Вывод не найден' })
    if (tx.status === 'completed') return res.status(400).json({ error: 'Вывод уже выполнен' })
    if (tx.status === 'cancelled') return res.status(400).json({ error: 'Вывод уже отменён' })

    const returnAmount = refund_amount ? parseFloat(refund_amount) : Math.abs(parseFloat(tx.amount))

    await client.query('BEGIN')
    await client.query("UPDATE transactions SET status='cancelled' WHERE id=$1", [tx.id])
    await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [returnAmount, tx.user_id])
    await client.query(
      "INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'deposit',$2,$3)",
      [tx.user_id, returnAmount, `↩️ Возврат вывода`]
    )
    await client.query('COMMIT')

    // Уведомляем юзера
    try {
      const { rows: [user] } = await client.query('SELECT * FROM users WHERE id=$1', [tx.user_id])
      const { getBot } = await import('../bot.js')
      const bot = getBot()
      if (bot && user) await bot.sendMessage(user.telegram_id,
        `↩️ <b>Вывод отменён</b>

На ваш баланс возвращено: <b>${returnAmount.toFixed(4)} TON</b>`,
        { parse_mode: 'HTML' }
      )
    } catch {}

    res.json({ ok: true, refunded: returnAmount })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// POST /api/admin/users/:id/balance — пополнить баланс юзера
router.post('/users/:id/balance', adminOnly, async (req, res) => {
  const client = await pool.connect()
  try {
    const { amount, comment } = req.body
    if (!amount || parseFloat(amount) === 0) return res.status(400).json({ error: 'Укажите сумму' })

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE id=$1', [req.params.id])
    if (!user) return res.status(404).json({ error: 'Юзер не найден' })

    const amt = parseFloat(amount)
    const label = comment || (amt > 0 ? '👑 Пополнение от админа' : '👑 Списание от админа')

    await client.query('BEGIN')
    await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [amt, user.id])
    await client.query(
      "INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'admin_adjust',$2,$3)",
      [user.id, amt, label]
    )
    await client.query('COMMIT')

    // Уведомляем юзера
    try {
      const { getBot } = await import('../bot.js')
      const bot = getBot()
      if (bot) await bot.sendMessage(user.telegram_id,
        `${amt > 0 ? '✅' : '⚠️'} <b>${amt > 0 ? 'Пополнение баланса' : 'Списание с баланса'}</b>

${amt > 0 ? '+' : ''}${amt.toFixed(4)} TON
${comment ? `📝 ${comment}` : ''}`,
        { parse_mode: 'HTML' }
      )
    } catch {}

    const { rows: [updated] } = await client.query('SELECT balance_ton FROM users WHERE id=$1', [user.id])
    res.json({ ok: true, new_balance: updated.balance_ton })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// GET /api/admin/users/:id/stats — детальная статистика юзера
router.get('/users/:id/stats', adminOnly, async (req, res) => {
  try {
    const { rows: [user] } = await pool.query(
      'SELECT * FROM users WHERE id=$1', [req.params.id]
    )
    if (!user) return res.status(404).json({ error: 'Not found' })

    const { rows: txs } = await pool.query(
      'SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    )
    const { rows: stakes } = await pool.query(
      'SELECT * FROM stakes WHERE user_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    )
    const { rows: tasks } = await pool.query(
      `SELECT t.title, ut.completed_at FROM user_tasks ut
       JOIN tasks t ON ut.task_id=t.id
       WHERE ut.user_id=$1 ORDER BY ut.completed_at DESC`,
      [req.params.id]
    )

    const totalDeposit = txs.filter(t => t.type === 'deposit').reduce((s, t) => s + parseFloat(t.amount), 0)
    const totalWithdraw = txs.filter(t => t.type === 'withdraw').reduce((s, t) => s + Math.abs(parseFloat(t.amount)), 0)
    const totalStaked = stakes.filter(s => s.status === 'active').reduce((s, t) => s + parseFloat(t.amount), 0)

    res.json({ user, txs, stakes, tasks, stats: { totalDeposit, totalWithdraw, totalStaked, tasksCount: tasks.length } })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/admin/maintenance
router.get('/maintenance', adminOnly, async (req, res) => {
  try {
    const { rows: [r] } = await pool.query("SELECT value FROM settings WHERE key='maintenance'")
    res.json({ maintenance: r?.value || '0' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/maintenance
router.post('/maintenance', adminOnly, async (req, res) => {
  try {
    await pool.query("UPDATE settings SET value=$1 WHERE key='maintenance'", [req.body.value])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/admin/backup
router.get('/backup', adminOnly, async (req, res) => {
  try {
    const [users, stakes, tasks, transactions, settings] = await Promise.all([
      pool.query('SELECT * FROM users'),
      pool.query('SELECT * FROM stakes'),
      pool.query('SELECT * FROM tasks'),
      pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 10000'),
      pool.query('SELECT * FROM settings'),
    ])
    const backup = {
      date: new Date().toISOString(),
      users: users.rows,
      stakes: stakes.rows,
      tasks: tasks.rows,
      transactions: transactions.rows,
      settings: settings.rows,
    }
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename=tonera-backup-${new Date().toISOString().slice(0,10)}.json`)
    res.json(backup)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/restore — восстановление из бэкапа
router.post('/restore', adminOnly, async (req, res) => {
  const client = await pool.connect()
  try {
    const { users, stakes, tasks, transactions, settings } = req.body
    if (!users || !stakes) return res.status(400).json({ error: 'Invalid backup file' })

    await client.query('BEGIN')

    // Восстанавливаем настройки
    if (settings?.length) {
      for (const s of settings) {
        await client.query(
          'INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
          [s.key, s.value]
        )
      }
    }

    // Восстанавливаем пользователей
    for (const u of users) {
      await client.query(`
        INSERT INTO users (id,telegram_id,username,first_name,balance_ton,bonus_balance,ref_code,referred_by,referral_count,is_blocked,ton_address,welcome_bonus_claimed,pending_ref,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (id) DO UPDATE SET
          balance_ton=$5, bonus_balance=$6, referral_count=$9, is_blocked=$10, ton_address=$11
      `, [u.id,u.telegram_id,u.username,u.first_name,u.balance_ton,u.bonus_balance,u.ref_code,u.referred_by,u.referral_count,u.is_blocked,u.ton_address,u.welcome_bonus_claimed,u.pending_ref,u.created_at])
    }

    // Восстанавливаем стейки
    for (const s of stakes) {
      await client.query(`
        INSERT INTO stakes (id,user_id,amount,earned,started_at,status,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO UPDATE SET amount=$3, earned=$4, status=$6
      `, [s.id,s.user_id,s.amount,s.earned,s.started_at,s.status,s.created_at])
    }

    // Восстанавливаем задания
    if (tasks?.length) {
      for (const t of tasks) {
        await client.query(`
          INSERT INTO tasks (id,creator_id,type,title,description,link,channel_title,channel_photo,icon,reward,price_per_exec,ref_bonus,project_fee,max_executions,executions,budget,active,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
          ON CONFLICT (id) DO NOTHING
        `, [t.id,t.creator_id,t.type,t.title,t.description,t.link,t.channel_title,t.channel_photo,t.icon,t.reward,t.price_per_exec,t.ref_bonus,t.project_fee,t.max_executions,t.executions,t.budget,t.active,t.created_at])
      }
    }

    await client.query('COMMIT')
    res.json({ ok: true, restored: { users: users.length, stakes: stakes.length, tasks: tasks?.length || 0 } })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})


// GET /api/admin/chart?days=7
router.get('/chart', adminOnly, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7
    const { rows } = await pool.query(`
      SELECT
        d::date as date,
        (SELECT COUNT(*) FROM users WHERE created_at::date = d::date) as new_users,
        (SELECT COUNT(DISTINCT user_id) FROM transactions WHERE created_at::date = d::date) as active_users,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='deposit' AND created_at::date = d::date) as deposits,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type IN('withdraw') AND created_at::date = d::date) as withdrawals,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type IN('trading_profit','spin_profit','fee') AND created_at::date = d::date) as profit,
        (SELECT COUNT(*) FROM transactions WHERE type='trading' AND created_at::date = d::date) as trading_bets,
        (SELECT COUNT(*) FROM transactions WHERE type='spin_result' AND created_at::date = d::date) as spins,
        (SELECT COUNT(*) FROM transactions WHERE type='task' AND created_at::date = d::date) as ads_viewed
      FROM generate_series(
        CURRENT_DATE - INTERVAL '1 day' * ($1-1),
        CURRENT_DATE,
        INTERVAL '1 day'
      ) d
      ORDER BY d
    `, [days])
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/admin/task-buyers/:id
router.get('/task-buyers/:id', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.username, u.first_name, ut.completed_at
       FROM user_tasks ut
       JOIN users u ON ut.user_id = u.id
       WHERE ut.task_id = $1
       ORDER BY ut.completed_at DESC`,
      [req.params.id]
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})


// GET /api/admin/task-templates
router.get('/task-templates', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM task_templates ORDER BY created_at DESC')
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/task-templates
router.post('/task-templates', adminOnly, async (req, res) => {
  try {
    const { title, link, channel_title, channel_photo, type, icon, reward } = req.body
    const { rows: [t] } = await pool.query(
      'INSERT INTO task_templates (title, link, channel_title, channel_photo, type, icon, reward) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [title, link||null, channel_title||null, channel_photo||null, type||'subscribe', icon||'✈️', reward||null]
    )
    res.json({ ok: true, template: t })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/admin/task-templates/:id
router.delete('/task-templates/:id', adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM task_templates WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})


// GET /api/admin/user-info/:tgId — найти юзера по telegram_id
router.get('/user-info/:tgId', adminOnly, async (req, res) => {
  try {
    const { rows: [user] } = await pool.query(
      'SELECT telegram_id, username, first_name FROM users WHERE telegram_id=$1',
      [req.params.tgId]
    )
    if (!user) return res.status(404).json({ error: 'Не найден' })
    res.json(user)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/admin/admins — список админов
router.get('/admins', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM admins ORDER BY added_at DESC')
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/admins — добавить админа
router.post('/admins', adminOnly, async (req, res) => {
  try {
    const tgId = Number(req.telegramUser?.id)
    if (tgId !== ADMIN_TG_ID) return res.status(403).json({ error: 'Только главный админ может добавлять' })
    const { telegram_id, username } = req.body
    if (!telegram_id) return res.status(400).json({ error: 'Введите Telegram ID' })
    if (Number(telegram_id) === ADMIN_TG_ID) return res.status(400).json({ error: 'Это главный админ' })
    const { rows: [a] } = await pool.query(
      'INSERT INTO admins (telegram_id, username) VALUES ($1,$2) ON CONFLICT (telegram_id) DO UPDATE SET username=$2 RETURNING *',
      [Number(telegram_id), username || null]
    )
    res.json({ ok: true, admin: a })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/admin/admins/:id — удалить админа
router.delete('/admins/:id', adminOnly, async (req, res) => {
  try {
    const tgId = Number(req.telegramUser?.id)
    if (tgId !== ADMIN_TG_ID) return res.status(403).json({ error: 'Только главный админ может удалять' })
    await pool.query('DELETE FROM admins WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// =================== АУКЦИОН РЕФЕРАЛОВ ===================

// GET /api/admin/auctions — all auctions
router.get('/auctions', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.*,
        u_seller.username as seller_username, u_seller.first_name as seller_name,
        u_ref.username as ref_username, u_ref.first_name as ref_name,
        u_winner.username as winner_username, u_winner.first_name as winner_name,
        (SELECT COUNT(*) FROM ref_auction_bids WHERE auction_id = a.id) as bid_count
      FROM ref_auctions a
      JOIN users u_seller ON a.seller_id = u_seller.id
      JOIN users u_ref ON a.referred_user_id = u_ref.id
      LEFT JOIN users u_winner ON a.winner_id = u_winner.id
      ORDER BY a.created_at DESC
      LIMIT 100
    `)
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/auctions/:id/close — force close auction (refund all bidders)
router.post('/auctions/:id/close', adminOnly, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [auction] } = await client.query(
      'SELECT * FROM ref_auctions WHERE id = $1 FOR UPDATE', [req.params.id]
    )
    if (!auction) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }

    // Refund locked funds to all bidders (production mode only)
    if (!auction.is_test) {
      const { rows: bids } = await client.query(
        'SELECT DISTINCT ON (bidder_id) bidder_id, amount FROM ref_auction_bids WHERE auction_id = $1 ORDER BY bidder_id, amount DESC',
        [auction.id]
      )
      for (const bid of bids) {
        await client.query(
          'UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2',
          [parseFloat(bid.amount), bid.bidder_id]
        )
      }
    }

    await client.query("UPDATE ref_auctions SET status = 'cancelled' WHERE id = $1", [auction.id])
    await client.query('COMMIT')
    res.json({ ok: true })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// DELETE /api/admin/auctions/:id — delete auction and refund bidders
router.delete('/auctions/:id', adminOnly, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [auction] } = await client.query(
      'SELECT * FROM ref_auctions WHERE id = $1 FOR UPDATE', [req.params.id]
    )
    if (!auction) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }

    // Refund locked funds if auction was active and not test
    if (auction.status === 'active' && !auction.is_test) {
      const { rows: bids } = await client.query(
        'SELECT DISTINCT ON (bidder_id) bidder_id, amount FROM ref_auction_bids WHERE auction_id = $1 ORDER BY bidder_id, amount DESC',
        [auction.id]
      )
      for (const bid of bids) {
        await client.query(
          'UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2',
          [parseFloat(bid.amount), bid.bidder_id]
        )
      }
    }

    await client.query('DELETE FROM ref_auction_bids WHERE auction_id = $1', [req.params.id])
    await client.query('DELETE FROM ref_auctions WHERE id = $1', [req.params.id])
    await client.query('COMMIT')
    res.json({ ok: true })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// GET /api/admin/auction-stats — stats
router.get('/auction-stats', adminOnly, async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM ref_auctions) as total_auctions,
        (SELECT COUNT(*) FROM ref_auctions WHERE status = 'active') as active_auctions,
        (SELECT COUNT(*) FROM ref_auctions WHERE status = 'completed') as completed_auctions,
        (SELECT COUNT(*) FROM ref_auction_bids) as total_bids,
        (SELECT COALESCE(SUM(current_price), 0) FROM ref_auctions WHERE status = 'completed') as total_volume,
        (SELECT COUNT(*) FROM ref_auctions WHERE is_test = true) as test_auctions
    `)
    res.json(stats)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// GET /api/admin/orphan-users — users without referrer that meet auction criteria
router.get('/orphan-users', adminOnly, async (req, res) => {
  try {
    // Get auction eligibility settings
    const { rows: settings } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('auction_min_tasks','auction_min_activity_days')"
    )
    const s = {}
    settings.forEach(r => s[r.key] = r.value)
    const minTasks = parseInt(s.auction_min_tasks || '50')
    const minDays = parseInt(s.auction_min_activity_days || '7')

    const { rows } = await pool.query(`
      SELECT u.id, u.telegram_id, u.username, u.first_name, u.created_at,
        t.tasks_completed,
        act.activity_30d,
        (SELECT EXISTS(SELECT 1 FROM ref_auctions WHERE referred_user_id = u.id AND status = 'active')) as on_auction
      FROM users u
      LEFT JOIN LATERAL (SELECT COUNT(*) as tasks_completed FROM user_tasks WHERE user_id = u.id) t ON true
      LEFT JOIN LATERAL (SELECT COUNT(*) as activity_30d FROM transactions WHERE user_id = u.id AND created_at > NOW() - INTERVAL '30 days') act ON true
      WHERE u.referred_by IS NULL
        AND t.tasks_completed >= $1
        AND EXISTS (SELECT 1 FROM transactions WHERE user_id = u.id AND created_at > NOW() - INTERVAL '1 day' * $2)
      ORDER BY t.tasks_completed DESC
      LIMIT 200
    `, [minTasks, minDays])
    res.json({ users: rows, min_tasks: minTasks, min_activity_days: minDays })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/auction/create-orphan — create auction for user without referrer
router.post('/auction/create-orphan', adminOnly, async (req, res) => {
  const client = await pool.connect()
  try {
    const { user_id, start_price, duration_hours } = req.body
    const adminTgId = req.telegramUser.id

    await client.query('BEGIN')

    // Get admin user
    const { rows: [admin] } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [adminTgId])
    if (!admin) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Админ не найден' }) }

    // Get target user
    const { rows: [targetUser] } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [user_id])
    if (!targetUser) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Юзер не найден' }) }

    // Check not already on auction
    const { rows: [existing] } = await client.query(
      "SELECT id FROM ref_auctions WHERE referred_user_id = $1 AND status = 'active'",
      [user_id]
    )
    if (existing) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Юзер уже на аукционе' }) }

    // Create referral record (admin becomes referrer) if not exists
    let refId
    const { rows: [existingRef] } = await client.query(
      'SELECT id FROM referrals WHERE referred_id = $1 AND referrer_id = $2',
      [user_id, admin.id]
    )
    if (existingRef) {
      refId = existingRef.id
    } else {
      const { rows: [newRef] } = await client.query(
        'INSERT INTO referrals (referrer_id, referred_id, bonus_paid) VALUES ($1, $2, true) RETURNING id',
        [admin.id, user_id]
      )
      refId = newRef.id
      // Update user's referred_by
      await client.query('UPDATE users SET referred_by = $1 WHERE id = $2 AND referred_by IS NULL', [admin.telegram_id, user_id])
      await client.query('UPDATE users SET referral_count = referral_count + 1 WHERE id = $1', [admin.id])
    }

    // Get auction settings
    const { rows: settings } = await client.query("SELECT key, value FROM settings WHERE key LIKE 'auction_%'")
    const s = {}
    settings.forEach(r => s[r.key] = r.value)
    const minPrice = parseFloat(s.auction_min_price || '0.1')
    const minStep = parseFloat(s.auction_min_step || '0.05')
    const maxDuration = parseInt(s.auction_max_duration || '24')
    const isTest = (s.auction_test_mode || '1') === '1'

    const price = parseFloat(start_price)
    if (isNaN(price) || price < minPrice) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Мин. цена: ${minPrice} TON` })
    }

    const hours = parseInt(duration_hours) || 24
    if (hours < 1 || hours > maxDuration) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Длительность: 1-${maxDuration} часов` })
    }

    const endsAt = new Date(Date.now() + hours * 3600000)
    const { rows: [auction] } = await client.query(
      `INSERT INTO ref_auctions (seller_id, referral_id, referred_user_id, start_price, current_price, min_step, duration_hours, ends_at, is_test)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8) RETURNING *`,
      [admin.id, refId, user_id, price, minStep, hours, endsAt, isTest]
    )

    await client.query('COMMIT')
    res.json({ ok: true, auction })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

export default router


