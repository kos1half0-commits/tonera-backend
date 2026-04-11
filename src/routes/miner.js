import { Router } from 'express'
import pool from '../db/index.js'
import { getBot } from '../bot.js'
import { ADMIN_TG_ID } from '../config.js'

const router = Router()

// Plan IDs in order
const PLAN_IDS = ['starter', 'advanced', 'pro', 'elite']

// Load all miner settings from DB
const getSettings = async () => {
  const { rows } = await pool.query(`SELECT key,value FROM settings WHERE key LIKE 'miner_%'`)
  const s = {}
  rows.forEach(r => s[r.key] = r.value)
  return s
}

// Build plans from settings
const getPlans = (s) => PLAN_IDS.map(id => ({
  id,
  price:    parseFloat(s[`miner_plan_${id}_price`] ?? 1),
  hashrate: parseFloat(s[`miner_plan_${id}_hashrate`] ?? 100),
  days:     parseInt(s[`miner_plan_${id}_days`] ?? 7),
}))

// Build trial plan from settings
const getTrialPlan = (s) => ({
  id: 'trial',
  price: 0,
  hashrate: parseFloat(s.miner_plan_trial_hashrate ?? 10),
  days: parseInt(s.miner_plan_trial_days ?? 1),
  enabled: parseInt(s.miner_plan_trial_enabled ?? 1) === 1,
  isTrial: true,
})

// Build free plan from settings
const getFreePlan = (s) => ({
  id: 'free',
  price: 0,
  hashrate: parseFloat(s.miner_plan_free_hashrate ?? 5),
  days: parseInt(s.miner_plan_free_days ?? 30),
  enabled: parseInt(s.miner_plan_free_enabled ?? 1) === 1,
  isFree: true,
})

// ============================
// GET /api/miner/plans — доступные планы
// ============================
router.get('/plans', async (req, res) => {
  try {
    const s = await getSettings()
    const plans = getPlans(s)
    const trial = getTrialPlan(s)
    const freePlan = getFreePlan(s)
    const ratePerGh = parseFloat(s.miner_rate_per_gh ?? 0.0000001)
    res.json({ plans, trial, freePlan, ratePerGh })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ============================
// POST /api/miner/trial — активировать бесплатный тест
// ============================
router.post('/trial', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    const s = await getSettings()
    const trial = getTrialPlan(s)
    if (!trial.enabled) return res.status(400).json({ error: 'Тестовый план отключён' })

    // Check if user already used trial
    const { rows: [existing] } = await pool.query(
      "SELECT id FROM miner_contracts WHERE user_id=$1 AND plan_id='trial'", [user.id]
    )
    if (existing) return res.status(400).json({ error: 'Вы уже использовали бесплатный пробный план' })

    const now = new Date()
    const expiresAt = new Date(now.getTime() + trial.days * 86400000)

    const { rows: [contract] } = await pool.query(
      `INSERT INTO miner_contracts (user_id, plan_id, hashrate, price_paid, duration_days, started_at, expires_at, last_accrual)
       VALUES ($1, 'trial', $2, 0, $3, $4, $5, $4) RETURNING *`,
      [user.id, trial.hashrate, trial.days, now, expiresAt]
    )

    res.json({ ok: true, contract })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ============================
// POST /api/miner/free — активировать бесплатный тариф
// ============================
router.post('/free', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    const s = await getSettings()
    const freePlan = getFreePlan(s)
    if (!freePlan.enabled) return res.status(400).json({ error: 'Бесплатный тариф временно отключён' })

    // Check if user already used free plan
    const { rows: [existing] } = await pool.query(
      "SELECT id FROM miner_contracts WHERE user_id=$1 AND plan_id='free'", [user.id]
    )
    if (existing) return res.status(400).json({ error: 'Вы уже активировали бесплатный тариф' })

    const now = new Date()
    const expiresAt = new Date(now.getTime() + freePlan.days * 86400000)

    const { rows: [contract] } = await pool.query(
      `INSERT INTO miner_contracts (user_id, plan_id, hashrate, price_paid, duration_days, started_at, expires_at, last_accrual)
       VALUES ($1, 'free', $2, 0, $3, $4, $5, $4) RETURNING *`,
      [user.id, freePlan.hashrate, freePlan.days, now, expiresAt]
    )

    // Notify admin (if notifications enabled)
    try {
      const notifyAdmin = parseInt(s.miner_free_notify_admin ?? 1) === 1
      if (notifyAdmin) {
        const bot = getBot()
        if (bot) await bot.sendMessage(ADMIN_TG_ID,
          `🆓 <b>Бесплатный тариф активирован</b>\n\n👤 ${user.username?'@'+user.username:user.first_name}\n⚡ ${freePlan.hashrate} GH/s\n📅 ${freePlan.days} дней`,
          { parse_mode: 'HTML' })
      }
    } catch {}

    res.json({ ok: true, contract })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ============================
// GET /api/miner/dashboard — дашборд пользователя
// ============================
router.get('/dashboard', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    const s = await getSettings()
    const enabled = parseInt(s.miner_enabled ?? 0)
    const ratePerGh = parseFloat(s.miner_rate_per_gh ?? 0.0000001)
    const minWithdraw = parseFloat(s.miner_min_withdraw ?? 0.01)
    const minerWallet = s.miner_wallet || ''

    // Active contracts
    const { rows: contracts } = await pool.query(
      `SELECT * FROM miner_contracts WHERE user_id=$1 ORDER BY created_at DESC`, [user.id]
    )

    // Calculate pending earnings since last accrual (live)
    const now = new Date()
    let totalHashrate = 0
    let contractsEarned = 0
    let totalPending = 0
    const minerBalance = parseFloat(user.miner_balance || 0)
    const contractsWithPending = contracts.map(c => {
      const earned = parseFloat(c.earned)
      const hashrate = parseFloat(c.hashrate)
      let pending = 0
      if (c.status === 'active' && new Date(c.expires_at) > now) {
        const hoursSinceAccrual = (now - new Date(c.last_accrual)) / 3600000
        pending = hashrate * ratePerGh * hoursSinceAccrual
        totalHashrate += hashrate
      }
      contractsEarned += earned
      totalPending += pending
      return { ...c, pendingEarned: pending, totalContractEarned: earned + pending }
    })

    // totalEarned = saved miner_balance + active contracts earned + pending
    const totalEarned = minerBalance + contractsEarned + totalPending

    // Total withdrawn by user
    const { rows: [wdSum] } = await pool.query(
      `SELECT COALESCE(SUM(amount),0) as total FROM miner_withdrawals WHERE user_id=$1 AND status IN ('pending','completed')`,
      [user.id]
    )
    const totalWithdrawn = parseFloat(wdSum.total)

    // Pending withdrawal requests
    const { rows: pendingWds } = await pool.query(
      `SELECT * FROM miner_withdrawals WHERE user_id=$1 AND status='pending' ORDER BY created_at DESC`, [user.id]
    )

    // Available balance = miner_balance + contracts earned + pending - withdrawn
    const availableBalance = totalEarned - totalWithdrawn

    // Network stats
    const { rows: [netStats] } = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status='active' AND expires_at > NOW() THEN hashrate ELSE 0 END), 0) as network_hashrate,
        COUNT(DISTINCT user_id) as total_miners,
        COUNT(CASE WHEN status='active' AND expires_at > NOW() THEN 1 END) as active_contracts,
        COALESCE(SUM(earned), 0) as total_mined
      FROM miner_contracts
    `)

    const totalPaid = parseFloat(s.miner_total_withdrawn ?? 0)

    res.json({
      enabled,
      minerWallet,
      minWithdraw,
      ratePerGh,
      totalHashrate,
      totalEarned,
      availableBalance,
      totalWithdrawn,
      contracts: contractsWithPending,
      pendingWithdrawals: pendingWds,
      network: {
        hashrate: parseFloat(netStats.network_hashrate),
        miners: parseInt(netStats.total_miners),
        activeContracts: parseInt(netStats.active_contracts),
        totalMined: parseFloat(netStats.total_mined),
        totalPaid,
      },
      plans: getPlans(s),
      trial: getTrialPlan(s),
      freePlan: getFreePlan(s),
      trialUsed: contracts.some(c => c.plan_id === 'trial'),
      freeUsed: contracts.some(c => c.plan_id === 'free'),
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ============================
// POST /api/miner/buy — купить контракт через TON Connect
// ============================
router.post('/buy', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { plan_id, tx_hash } = req.body
    if (!plan_id || !tx_hash) return res.status(400).json({ error: 'Требуется plan_id и tx_hash' })

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    // Check tx not used
    const { rows: [usedTx] } = await client.query(
      "SELECT id FROM transactions WHERE status=$1", [`miner_contract:${tx_hash.slice(0,64)}`]
    )
    if (usedTx) return res.status(400).json({ error: 'Транзакция уже использована' })

    const s = await getSettings()
    const plans = getPlans(s)
    const plan = plans.find(p => p.id === plan_id)
    if (!plan) return res.status(400).json({ error: 'План не найден' })

    // === BLOCKCHAIN VERIFICATION ===
    const minerWallet = s.miner_wallet || ''
    if (!minerWallet) return res.status(500).json({ error: 'Кошелёк майнера не настроен' })

    // Wait for transaction to appear
    await new Promise(r => setTimeout(r, 8000))

    let realAmount = 0
    let chainHash = null

    try {
      const txRes = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${minerWallet}&limit=50`)
      const txData = await txRes.json()

      if (txData.ok && txData.result) {
        const expectedNano = Math.floor(plan.price * 1e9)
        const now = Date.now() / 1000

        console.log(`[MINER BUY] Looking for ${plan.price} TON (${expectedNano} nano) on wallet ${minerWallet}`)

        for (const tx of txData.result) {
          const inMsg = tx.in_msg
          if (!inMsg || !inMsg.value) continue
          const txNano = parseInt(inMsg.value)
          const timeDiff = now - tx.utime
          const diffNano = Math.abs(txNano - expectedNano)

          if (diffNano < 10000000 && timeDiff < 1800 && timeDiff > 0) {
            const hash = tx.transaction_id?.hash || `${tx.utime}`
            const { rows: [usedChain] } = await client.query(
              "SELECT id FROM transactions WHERE status=$1", [`miner_contract:${hash}`]
            )
            if (!usedChain) {
              realAmount = txNano / 1e9
              chainHash = hash
              console.log(`[MINER BUY] ✅ Match: ${realAmount} TON, hash=${hash}`)
              break
            } else {
              console.log(`[MINER BUY] ⚠️ TX ${hash} already used`)
            }
          }
        }
      } else {
        console.log(`[MINER BUY] ❌ toncenter API error:`, txData)
      }
    } catch (e) {
      console.error('[MINER BUY] Verify error:', e.message)
      return res.status(500).json({ error: 'Не удалось проверить транзакцию. Попробуйте позже.' })
    }

    if (!realAmount || !chainHash) {
      console.log(`[MINER BUY] ❌ No matching TX for user ${tgId}, plan=${plan_id}, expected=${plan.price} TON`)
      return res.status(400).json({ error: 'Транзакция не найдена в блокчейне. Подождите 15 секунд и попробуйте снова.' })
    }

    // === CREATE CONTRACT ===
    const now = new Date()
    const expiresAt = new Date(now.getTime() + plan.days * 86400000)

    await client.query('BEGIN')

    const { rows: [contract] } = await client.query(
      `INSERT INTO miner_contracts (user_id, plan_id, hashrate, price_paid, duration_days, started_at, expires_at, last_accrual)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $6) RETURNING *`,
      [user.id, plan.id, plan.hashrate, realAmount, plan.days, now, expiresAt]
    )

    await client.query(
      "INSERT INTO transactions (user_id,type,amount,label,status) VALUES ($1,'miner_contract',$2,$3,$4)",
      [user.id, -realAmount, `⛏ Контракт ${plan.id.toUpperCase()} · ${plan.hashrate} GH/s · ${plan.days}д`, `miner_contract:${chainHash}`]
    )

    await client.query('COMMIT')

    try {
      const bot = getBot()
      if (bot) await bot.sendMessage(ADMIN_TG_ID,
        `⛏ <b>Новый контракт майнинга</b>\n\n👤 ${user.username?'@'+user.username:user.first_name}\n📋 ${plan.id.toUpperCase()}\n⚡ ${plan.hashrate} GH/s\n📅 ${plan.days} дней\n💰 ${realAmount} TON ✅ Verified`,
        { parse_mode: 'HTML' })
    } catch {}

    res.json({ ok: true, contract })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// ============================
// POST /api/miner/withdraw — запрос на вывод
// ============================
router.post('/withdraw', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount, wallet_address } = req.body
    if (!wallet_address) return res.status(400).json({ error: 'Укажите адрес кошелька' })
    const amt = parseFloat(amount)
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Неверная сумма' })

    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1 FOR UPDATE', [tgId])
    if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }) }

    const s = await getSettings()
    const minWithdraw = parseFloat(s.miner_min_withdraw ?? 0.01)
    if (amt < minWithdraw) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Мин. вывод: ${minWithdraw} TON` })
    }

    const ratePerGh = parseFloat(s.miner_rate_per_gh ?? 0.0000001)

    // Calculate total available (miner_balance + contracts earned + pending - withdrawn)
    const minerBalance = parseFloat(user.miner_balance || 0)
    const { rows: contracts } = await client.query(
      `SELECT * FROM miner_contracts WHERE user_id=$1 FOR UPDATE`, [user.id]
    )
    const now = new Date()
    let contractsEarned = 0
    for (const c of contracts) {
      contractsEarned += parseFloat(c.earned)
      if (c.status === 'active' && new Date(c.expires_at) > now) {
        const hours = (now - new Date(c.last_accrual)) / 3600000
        contractsEarned += parseFloat(c.hashrate) * ratePerGh * hours
      }
    }

    // Accrue earnings now before withdrawal
    for (const c of contracts) {
      if (c.status === 'active' && new Date(c.expires_at) > now) {
        const hours = (now - new Date(c.last_accrual)) / 3600000
        const accrued = parseFloat(c.hashrate) * ratePerGh * hours
        await client.query(
          'UPDATE miner_contracts SET earned=earned+$1, last_accrual=$2 WHERE id=$3',
          [accrued, now, c.id]
        )
      }
    }

    const { rows: [wdSum] } = await client.query(
      `SELECT COALESCE(SUM(amount),0) as total FROM miner_withdrawals WHERE user_id=$1 AND status IN ('pending','completed')`,
      [user.id]
    )
    const totalWithdrawn = parseFloat(wdSum.total)
    const totalEarned = minerBalance + contractsEarned
    const available = totalEarned - totalWithdrawn

    if (amt > available + 0.000001) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Недостаточно средств. Доступно: ${available.toFixed(6)} TON` })
    }

    const { rows: [wd] } = await client.query(
      `INSERT INTO miner_withdrawals (user_id, amount, wallet_address) VALUES ($1, $2, $3) RETURNING *`,
      [user.id, amt, wallet_address]
    )

    await client.query('COMMIT')

    try {
      const bot = getBot()
      if (bot) await bot.sendMessage(ADMIN_TG_ID,
        `💰 <b>Запрос на вывод с майнера</b>\n\n👤 ${user.username?'@'+user.username:user.first_name}\n💎 ${amt.toFixed(6)} TON\n📬 <code>${wallet_address}</code>`,
        { parse_mode: 'HTML' })
    } catch {}

    res.json({ ok: true, withdrawal: wd })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// ============================
// GET /api/miner/history — история пользователя
// ============================
router.get('/history', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query('SELECT id FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.json({ contracts: [], withdrawals: [] })

    const { rows: contracts } = await pool.query(
      `SELECT * FROM miner_contracts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [user.id]
    )
    const { rows: withdrawals } = await pool.query(
      `SELECT * FROM miner_withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [user.id]
    )
    res.json({ contracts, withdrawals })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ============================
// ADMIN ENDPOINTS
// ============================

// GET /api/miner/all — все контракты
router.get('/all', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT mc.*, u.username, u.first_name, u.telegram_id
      FROM miner_contracts mc JOIN users u ON mc.user_id = u.id
      ORDER BY mc.created_at DESC
    `)
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/miner/admin/withdrawals — запросы на вывод
router.get('/admin/withdrawals', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT mw.*, u.username, u.first_name, u.telegram_id
      FROM miner_withdrawals mw JOIN users u ON mw.user_id = u.id
      ORDER BY mw.created_at DESC LIMIT 200
    `)
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/miner/admin/approve/:id — подтвердить вывод
router.post('/admin/approve/:id', async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [wd] } = await client.query(
      "UPDATE miner_withdrawals SET status='completed' WHERE id=$1 AND status='pending' RETURNING *",
      [req.params.id]
    )
    if (!wd) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Не найден или уже обработан' }) }

    // Update total_withdrawn in settings
    await client.query(
      "UPDATE settings SET value = (CAST(value AS NUMERIC) + $1)::TEXT WHERE key='miner_total_withdrawn'",
      [wd.amount]
    )

    await client.query('COMMIT')

    // Notify user
    try {
      const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id=$1', [wd.user_id])
      const bot = getBot()
      if (bot && user) await bot.sendMessage(user.telegram_id,
        `✅ <b>Вывод с майнера одобрен</b>\n\n💎 ${parseFloat(wd.amount).toFixed(6)} TON отправлено на ваш кошелёк.\n📬 <code>${wd.wallet_address}</code>`,
        { parse_mode: 'HTML' })
    } catch {}

    res.json({ ok: true })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// POST /api/miner/admin/reject/:id — отклонить вывод
router.post('/admin/reject/:id', async (req, res) => {
  try {
    const { rows: [wd] } = await pool.query(
      "UPDATE miner_withdrawals SET status='rejected', admin_note=$2 WHERE id=$1 AND status='pending' RETURNING *",
      [req.params.id, req.body.note || '']
    )
    if (!wd) return res.status(400).json({ error: 'Не найден или уже обработан' })

    // Notify user
    try {
      const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id=$1', [wd.user_id])
      const bot = getBot()
      if (bot && user) await bot.sendMessage(user.telegram_id,
        `❌ <b>Вывод с майнера отклонён</b>\n\n💎 ${parseFloat(wd.amount).toFixed(6)} TON возвращено на баланс майнера.${req.body.note ? `\n📝 ${req.body.note}` : ''}`,
        { parse_mode: 'HTML' })
    } catch {}

    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/miner/admin/stats — статистика майнинга
router.get('/admin/stats', async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*) as total_contracts,
        COUNT(CASE WHEN status='active' AND expires_at > NOW() THEN 1 END) as active_contracts,
        COUNT(DISTINCT user_id) as total_miners,
        COALESCE(SUM(price_paid), 0) as total_revenue,
        COALESCE(SUM(earned), 0) as total_mined,
        COALESCE(SUM(CASE WHEN status='active' AND expires_at > NOW() THEN hashrate ELSE 0 END), 0) as network_hashrate
      FROM miner_contracts
    `)
    const { rows: [wdStats] } = await pool.query(`
      SELECT
        COUNT(CASE WHEN status='pending' THEN 1 END) as pending_withdrawals,
        COALESCE(SUM(CASE WHEN status='pending' THEN amount ELSE 0 END), 0) as pending_amount,
        COALESCE(SUM(CASE WHEN status='completed' THEN amount ELSE 0 END), 0) as paid_amount
      FROM miner_withdrawals
    `)
    res.json({ ...stats, ...wdStats })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/miner/contract/:id — удалить контракт (админ), сохраняя заработок
router.delete('/contract/:id', async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Get contract details before deleting
    const { rows: [contract] } = await client.query(
      'SELECT * FROM miner_contracts WHERE id=$1 FOR UPDATE', [req.params.id]
    )
    if (!contract) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Контракт не найден' }) }

    // Accrue any pending earnings
    let totalEarned = parseFloat(contract.earned)
    const now = new Date()
    if (contract.status === 'active' && new Date(contract.expires_at) > now) {
      const s = await getSettings()
      const ratePerGh = parseFloat(s.miner_rate_per_gh ?? 0.0000001)
      const hours = (now - new Date(contract.last_accrual)) / 3600000
      totalEarned += parseFloat(contract.hashrate) * ratePerGh * hours
    }

    // Save earned to miner_balance so available balance is preserved
    if (totalEarned > 0) {
      await client.query(
        'UPDATE users SET miner_balance = COALESCE(miner_balance, 0) + $1 WHERE id = $2',
        [totalEarned, contract.user_id]
      )
    }

    await client.query('DELETE FROM miner_contracts WHERE id=$1', [req.params.id])
    await client.query('COMMIT')
    res.json({ ok: true, credited: totalEarned })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// ============================
// ADMIN: User Mining Management
// ============================

// GET /api/miner/admin/user/:tgId — профиль майнинга юзера по telegram_id
router.get('/admin/user/:tgId', async (req, res) => {
  try {
    const { rows: [user] } = await pool.query(
      'SELECT id, telegram_id, username, first_name FROM users WHERE telegram_id=$1', [req.params.tgId]
    )
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' })

    const { rows: contracts } = await pool.query(
      'SELECT * FROM miner_contracts WHERE user_id=$1 ORDER BY created_at DESC', [user.id]
    )
    const { rows: withdrawals } = await pool.query(
      'SELECT * FROM miner_withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [user.id]
    )

    const s = await getSettings()
    const ratePerGh = parseFloat(s.miner_rate_per_gh ?? 0.0000001)
    const now = new Date()

    const minerBalance = parseFloat(user.miner_balance || 0)
    let totalHashrate = 0
    let contractsEarned = 0
    const contractsEnriched = contracts.map(c => {
      const hr = parseFloat(c.hashrate)
      const earned = parseFloat(c.earned)
      let pending = 0
      if (c.status === 'active' && new Date(c.expires_at) > now) {
        const hours = (now - new Date(c.last_accrual)) / 3600000
        pending = hr * ratePerGh * hours
        totalHashrate += hr
      }
      contractsEarned += earned + pending
      return { ...c, pendingEarned: pending }
    })

    const totalEarned = minerBalance + contractsEarned

    const { rows: [wdSum] } = await pool.query(
      `SELECT COALESCE(SUM(amount),0) as total FROM miner_withdrawals WHERE user_id=$1 AND status IN ('pending','completed')`,
      [user.id]
    )
    const totalWithdrawn = parseFloat(wdSum.total)

    res.json({
      user,
      contracts: contractsEnriched,
      withdrawals,
      totalHashrate,
      totalEarned,
      totalWithdrawn,
      availableBalance: totalEarned - totalWithdrawn,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/miner/admin/users — список всех юзеров с майнингом (группировка по юзерам)
router.get('/admin/users', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        u.id, u.telegram_id, u.username, u.first_name,
        COUNT(mc.id) as contract_count,
        COUNT(CASE WHEN mc.status='active' AND mc.expires_at > NOW() THEN 1 END) as active_count,
        COALESCE(SUM(mc.hashrate), 0) as total_hashrate,
        COALESCE(SUM(mc.earned), 0) as total_earned,
        COALESCE(SUM(mc.price_paid), 0) as total_paid
      FROM users u
      JOIN miner_contracts mc ON mc.user_id = u.id
      GROUP BY u.id
      ORDER BY active_count DESC, total_earned DESC
    `)
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/miner/admin/create-contract — создать контракт вручную (бесплатно или с ценой)
router.post('/admin/create-contract', async (req, res) => {
  try {
    const { telegram_id, plan_id, hashrate, days, price_paid, earned } = req.body
    if (!telegram_id) return res.status(400).json({ error: 'Нужен telegram_id' })
    if (!hashrate || !days) return res.status(400).json({ error: 'Нужны hashrate и days' })

    const { rows: [user] } = await pool.query('SELECT id FROM users WHERE telegram_id=$1', [telegram_id])
    if (!user) return res.status(404).json({ error: 'Юзер не найден' })

    const now = new Date()
    const expiresAt = new Date(now.getTime() + parseInt(days) * 86400000)

    const { rows: [contract] } = await pool.query(
      `INSERT INTO miner_contracts (user_id, plan_id, hashrate, price_paid, earned, duration_days, started_at, expires_at, last_accrual)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7) RETURNING *`,
      [user.id, plan_id || 'admin', parseFloat(hashrate), parseFloat(price_paid || 0), parseFloat(earned || 0), parseInt(days), now, expiresAt]
    )

    res.json({ ok: true, contract })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// PUT /api/miner/admin/contract/:id — редактировать контракт
router.put('/admin/contract/:id', async (req, res) => {
  try {
    const { hashrate, earned, days_add, status, plan_id } = req.body
    const updates = []
    const vals = []
    let i = 1

    if (hashrate !== undefined) { updates.push(`hashrate=$${i++}`); vals.push(parseFloat(hashrate)) }
    if (earned !== undefined) { updates.push(`earned=$${i++}`); vals.push(parseFloat(earned)) }
    if (status !== undefined) { updates.push(`status=$${i++}`); vals.push(status) }
    if (plan_id !== undefined) { updates.push(`plan_id=$${i++}`); vals.push(plan_id) }

    if (days_add !== undefined && parseInt(days_add) !== 0) {
      updates.push(`expires_at=expires_at + INTERVAL '${parseInt(days_add)} days'`)
      updates.push(`duration_days=duration_days+$${i++}`)
      vals.push(parseInt(days_add))
    }

    if (!updates.length) return res.status(400).json({ error: 'Нет изменений' })

    vals.push(req.params.id)
    const { rows: [contract] } = await pool.query(
      `UPDATE miner_contracts SET ${updates.join(',')} WHERE id=$${i} RETURNING *`, vals
    )
    if (!contract) return res.status(404).json({ error: 'Контракт не найден' })
    res.json({ ok: true, contract })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/miner/admin/add-hashrate/:tgId — быстрое добавление хешрейта юзеру (создаёт новый контракт)
router.post('/admin/add-hashrate/:tgId', async (req, res) => {
  try {
    const { hashrate, days } = req.body
    if (!hashrate || !days) return res.status(400).json({ error: 'Нужны hashrate и days' })

    const { rows: [user] } = await pool.query('SELECT id, username, first_name FROM users WHERE telegram_id=$1', [req.params.tgId])
    if (!user) return res.status(404).json({ error: 'Юзер не найден' })

    const now = new Date()
    const expiresAt = new Date(now.getTime() + parseInt(days) * 86400000)

    const { rows: [contract] } = await pool.query(
      `INSERT INTO miner_contracts (user_id, plan_id, hashrate, price_paid, duration_days, started_at, expires_at, last_accrual)
       VALUES ($1, 'admin_gift', $2, 0, $3, $4, $5, $4) RETURNING *`,
      [user.id, parseFloat(hashrate), parseInt(days), now, expiresAt]
    )

    // Notify user
    try {
      const bot = getBot()
      if (bot) await bot.sendMessage(req.params.tgId,
        `🎁 <b>Вам начислен хешрейт!</b>\n\n⚡ ${parseFloat(hashrate).toFixed(0)} GH/s\n📅 ${days} дней\n\nНачните зарабатывать TON прямо сейчас!`,
        { parse_mode: 'HTML' })
    } catch {}

    res.json({ ok: true, contract })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/miner/admin/set-earned/:contractId — установить/изменить earned
router.post('/admin/set-earned/:contractId', async (req, res) => {
  try {
    const { earned, add } = req.body
    let query, params
    if (add !== undefined) {
      query = 'UPDATE miner_contracts SET earned=earned+$1 WHERE id=$2 RETURNING *'
      params = [parseFloat(add), req.params.contractId]
    } else if (earned !== undefined) {
      query = 'UPDATE miner_contracts SET earned=$1 WHERE id=$2 RETURNING *'
      params = [parseFloat(earned), req.params.contractId]
    } else {
      return res.status(400).json({ error: 'Нужен earned или add' })
    }
    const { rows: [contract] } = await pool.query(query, params)
    if (!contract) return res.status(404).json({ error: 'Контракт не найден' })
    res.json({ ok: true, contract })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ============================
// ADMIN: Free Plan Management
// ============================

// GET /api/miner/admin/free-stats — статистика бесплатного тарифа
router.get('/admin/free-stats', async (req, res) => {
  try {
    const s = await getSettings()
    const freePlan = getFreePlan(s)

    const { rows: [freeStats] } = await pool.query(`
      SELECT
        COUNT(*) as total_activated,
        COUNT(CASE WHEN status='active' AND expires_at > NOW() THEN 1 END) as active_count,
        COALESCE(SUM(earned), 0) as total_earned,
        COALESCE(SUM(CASE WHEN status='active' AND expires_at > NOW() THEN hashrate ELSE 0 END), 0) as active_hashrate
      FROM miner_contracts WHERE plan_id='free'
    `)

    res.json({
      enabled: freePlan.enabled,
      hashrate: freePlan.hashrate,
      days: freePlan.days,
      totalActivated: parseInt(freeStats.total_activated),
      activeCount: parseInt(freeStats.active_count),
      totalEarned: parseFloat(freeStats.total_earned),
      activeHashrate: parseFloat(freeStats.active_hashrate),
      notifyAdmin: parseInt(s.miner_free_notify_admin ?? 1) === 1,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/miner/admin/free-toggle — вкл/выкл бесплатный тариф
router.post('/admin/free-toggle', async (req, res) => {
  try {
    const s = await getSettings()
    const current = parseInt(s.miner_plan_free_enabled ?? 1)
    const newVal = current === 1 ? '0' : '1'
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('miner_plan_free_enabled', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`, [newVal]
    )
    res.json({ ok: true, enabled: newVal === '1' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/miner/admin/free-update — обновить настройки бесплатного тарифа
router.post('/admin/free-update', async (req, res) => {
  try {
    const { hashrate, days } = req.body
    if (hashrate !== undefined) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('miner_plan_free_hashrate', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`, [String(hashrate)]
      )
    }
    if (days !== undefined) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('miner_plan_free_days', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`, [String(days)]
      )
    }
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/miner/admin/free-notify-toggle — вкл/выкл уведомления админу о бесплатном тарифе
router.post('/admin/free-notify-toggle', async (req, res) => {
  try {
    const s = await getSettings()
    const current = parseInt(s.miner_free_notify_admin ?? 1)
    const newVal = current === 1 ? '0' : '1'
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('miner_free_notify_admin', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`, [newVal]
    )
    res.json({ ok: true, notifyAdmin: newVal === '1' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
