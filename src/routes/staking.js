import { Router } from 'express'
import pool from '../db/index.js'
import { getBot } from '../bot.js'
import { ADMIN_TG_ID } from '../config.js'

const router = Router()
const DAILY_RATE = 0.01

// Единая формула расчёта дохода — используется везде
function calcEarned(amount, startedAt, savedEarned = 0) {
  const msPerDay = 1000 * 60 * 60 * 24
  const elapsedMs = Date.now() - new Date(startedAt).getTime()
  return parseFloat(savedEarned) + parseFloat(amount) * DAILY_RATE / msPerDay * elapsedMs
}

router.get('/info', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('min_deposit','min_withdraw','min_reinvest','min_collect','staking_withdraw_fee','task_price','task_reward','task_ref_bonus','task_project_fee','launch_date')"
    )
    const mins = {}
    const prices = {}
    let stakingWithdrawFee = 0
    rows.forEach(r => {
      if (r.key.startsWith('min_')) mins[r.key.replace('min_', '')] = parseFloat(r.value)
      else if (r.key === 'staking_withdraw_fee') stakingWithdrawFee = parseFloat(r.value)
      else if (r.key === 'launch_date') prices['launch_date'] = r.value
      else prices[r.key] = parseFloat(r.value)
    })
    res.json({ daily_rate: DAILY_RATE, daily_percent: 1, mins, prices, staking_withdraw_fee: stakingWithdrawFee })
  } catch {
    res.json({ daily_rate: DAILY_RATE, daily_percent: 1, mins: { deposit: 0.01, withdraw: 0.01, reinvest: 0.001 }, prices: {} })
  }
})

router.get('/my', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await client.query('SELECT id FROM users WHERE telegram_id=$1', [tgId])
    if (!user) { client.release(); return res.json([]) }

    await client.query('BEGIN')

    const { rows } = await client.query(
      `SELECT * FROM stakes WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC FOR UPDATE`,
      [user.id]
    )

    // Авто-объединение дублированных стейков — без потери баланса
    if (rows.length > 1) {
      let totalAmount = 0
      let totalEarned = 0
      const keepStake = rows[0] // оставляем самый новый

      for (const s of rows) {
        const earned = calcEarned(s.amount, s.started_at, s.earned)
        totalAmount += parseFloat(s.amount)
        totalEarned += earned
      }

      // Обновляем основной стейк — весь баланс и доход сохранён
      await client.query(
        'UPDATE stakes SET amount=$1, earned=$2, started_at=NOW() WHERE id=$3',
        [totalAmount, totalEarned, keepStake.id]
      )

      // Помечаем лишние стейки как объединённые
      const otherIds = rows.filter(s => s.id !== keepStake.id).map(s => s.id)
      if (otherIds.length > 0) {
        await client.query(
          `UPDATE stakes SET status='merged', earned=0, amount=0 WHERE id = ANY($1::int[])`,
          [otherIds]
        )
      }

      await client.query('COMMIT')
      console.log(`[STAKING] Consolidated ${rows.length} stakes into one for user ${tgId}, total=${totalAmount}, earned=${totalEarned}`)

      return res.json([{
        ...keepStake,
        amount: totalAmount.toFixed(8),
        earned: totalEarned,
        started_at: new Date(),
        daily_reward: totalAmount * DAILY_RATE,
      }])
    }

    await client.query('COMMIT')

    const result = rows.map(s => ({
      ...s,
      earned: parseFloat(s.earned || 0),
      daily_reward: parseFloat(s.amount) * DAILY_RATE,
    }))
    res.json(result)
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

router.post('/stake', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount } = req.body
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' })

    // Проверяем минимальный депозит
    const { rows: [minDep] } = await client.query("SELECT value FROM settings WHERE key='min_deposit'")
    const minDepositVal = parseFloat(minDep?.value || 0.01)
    if (parseFloat(amount) < minDepositVal) {
      return res.status(400).json({ error: `Минимальный депозит: ${minDepositVal} TON` })
    }

    await client.query('BEGIN')

    // FOR UPDATE — блокируем строку юзера от параллельных изменений
    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE', [tgId])
    if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }) }
    if (parseFloat(user.balance_ton) < parseFloat(amount)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient balance' }) }

    await client.query('UPDATE users SET balance_ton = balance_ton - $1 WHERE id = $2', [amount, user.id])

    // Проверяем существующий активный стейк — добавляем к нему вместо создания дубликата
    const { rows: [existing] } = await client.query(
      "SELECT * FROM stakes WHERE user_id=$1 AND status='active' FOR UPDATE",
      [user.id]
    )

    let stake
    if (existing) {
      // Добавляем к существующему стейку, сохраняя накопленный доход
      const currentEarned = calcEarned(existing.amount, existing.started_at, existing.earned)
      const { rows: [s] } = await client.query(
        `UPDATE stakes SET amount=amount+$1, earned=$2, started_at=NOW() WHERE id=$3 RETURNING *`,
        [amount, currentEarned, existing.id]
      )
      stake = s
    } else {
      const { rows: [s] } = await client.query(
        `INSERT INTO stakes (user_id, amount, started_at, status) VALUES ($1, $2, NOW(), 'active') RETURNING *`,
        [user.id, amount]
      )
      stake = s
    }

    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1, 'stake', $2, 'Стейкинг')`,
      [user.id, -parseFloat(amount)]
    )

    await client.query('COMMIT')
    res.json({ stake: { ...stake, earned: parseFloat(stake.earned || 0), daily_reward: parseFloat(stake.amount) * DAILY_RATE } })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

router.post('/unstake/:stakeId', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { stakeId } = req.params
    const label = req.body?.label || 'Вывод стейка + доход'

    await client.query('BEGIN')

    // FOR UPDATE — блокируем стейк и юзера
    const { rows: [stake] } = await client.query(
      `SELECT s.*, u.id as uid FROM stakes s JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND u.telegram_id = $2 AND s.status = 'active'
       FOR UPDATE OF s`,
      [stakeId, tgId]
    )
    if (!stake) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Stake not found' }) }

    // Считаем earned на сервере (единая формула)
    const earned = calcEarned(stake.amount, stake.started_at, stake.earned)
    const returnAmount = parseFloat(stake.amount) + earned

    // Всегда начисляем баланс при unstake (убран параметр internal от клиента)
    await client.query('UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2', [returnAmount, stake.uid])
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1, 'collect', $2, $3)`,
      [stake.uid, returnAmount, label]
    )

    await client.query(`UPDATE stakes SET status = 'completed', earned = $1 WHERE id = $2`, [earned, stakeId])
    await client.query('COMMIT')
    res.json({ success: true, returned: returnAmount, principal: parseFloat(stake.amount), earned })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

// POST /api/staking/withdraw — частичный вывод из стейка
router.post('/withdraw', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount, stakeId } = req.body
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' })

    await client.query('BEGIN')

    // FOR UPDATE — блокируем стейк
    const { rows: [stake] } = await client.query(
      `SELECT s.*, u.id as uid FROM stakes s JOIN users u ON s.user_id=u.id
       WHERE s.id=$1 AND u.telegram_id=$2 AND s.status='active'
       FOR UPDATE OF s`,
      [stakeId, tgId]
    )
    if (!stake) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Stake not found' }) }

    const withdrawAmt = parseFloat(amount)
    if (withdrawAmt > parseFloat(stake.amount)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Amount exceeds stake' }) }

    // Считаем earned на сервере (единая формула)
    const currentEarned = calcEarned(stake.amount, stake.started_at, stake.earned)
    const newAmount = parseFloat(stake.amount) - withdrawAmt

    // Получаем комиссию за вывод из стейка
    const { rows: [stFee] } = await client.query("SELECT value FROM settings WHERE key='staking_withdraw_fee'")
    const feePercent = parseFloat(stFee?.value || 0) / 100
    const fee = withdrawAmt * feePercent
    const netWithdraw = withdrawAmt - fee
    console.log(`WITHDRAW: amount=${withdrawAmt} fee%=${feePercent} fee=${fee} net=${netWithdraw}`)

    // Начисляем выводимую сумму за вычетом комиссии
    await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [netWithdraw, stake.uid])

    // Комиссия на аккаунт админа
    if (fee > 0) {
      const { rows: [admin] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [ADMIN_TG_ID])
      if (admin) {
        await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [fee, admin.id])
        await client.query(
          "INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'fee',$2,'Комиссия стейкинга')",
          [admin.id, fee]
        )
        // Уведомление админу
        try {
          const bot = getBot()
          if (bot) {
            const { rows: [u] } = await client.query('SELECT * FROM users WHERE id=$1', [stake.uid])
            await bot.sendMessage(ADMIN_TG_ID,
              `💰 <b>Комиссия за вывод из стейка</b>\n\n👤 ${u?.username ? '@'+u.username : u?.first_name}\n💎 Вывод: <b>${withdrawAmt} TON</b>\n🏦 Ваша комиссия: <b>${fee.toFixed(4)} TON</b>`,
              { parse_mode: 'HTML' }
            )
          }
        } catch {}
      }
    }

    if (newAmount > 0) {
      // Уменьшаем стейк, сохраняем доход, сбрасываем время
      await client.query(
        'UPDATE stakes SET amount=$1, earned=$2, started_at=NOW() WHERE id=$3',
        [newAmount, currentEarned, stakeId]
      )
    } else {
      // Закрываем стейк
      await client.query("UPDATE stakes SET status='completed', earned=$1 WHERE id=$2", [currentEarned, stakeId])
    }

    await client.query(
      `INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'collect',$2,$3)`,
      [stake.uid, netWithdraw, fee > 0 ? `Вывод из стейка (комиссия ${(feePercent*100).toFixed(0)}%)` : 'Вывод из стейка']
    )

    await client.query('COMMIT')
    res.json({ ok: true, netWithdraw, fee })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

// POST /api/staking/collect/:stakeId — собрать доход
router.post('/collect/:stakeId', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { stakeId } = req.params

    await client.query('BEGIN')

    // FOR UPDATE — блокируем стейк
    const { rows: [stake] } = await client.query(
      `SELECT s.*, u.id as uid FROM stakes s JOIN users u ON s.user_id = u.id
       WHERE s.id=$1 AND u.telegram_id=$2 AND s.status='active'
       FOR UPDATE OF s`,
      [stakeId, tgId]
    )
    if (!stake) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Stake not found' }) }

    // Считаем earned на сервере (единая формула)
    const earned = calcEarned(stake.amount, stake.started_at, stake.earned)

    if (earned <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Нет дохода для сбора' }) }

    // Начисляем доход на баланс
    await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [earned, stake.uid])

    // Сбрасываем earned и started_at, сумма депозита не меняется
    await client.query('UPDATE stakes SET earned=0, started_at=NOW() WHERE id=$1', [stakeId])

    await client.query(
      `INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'collect',$2,'Сбор дохода')`,
      [stake.uid, earned]
    )

    await client.query('COMMIT')
    res.json({ ok: true, earned })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

// POST /api/staking/add — добавить к существующему стейку
router.post('/add', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount, stakeId } = req.body
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' })

    await client.query('BEGIN')

    // FOR UPDATE — блокируем юзера
    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1 FOR UPDATE', [tgId])
    if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }) }
    if (parseFloat(user.balance_ton) < parseFloat(amount)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient balance' }) }

    // Списываем только добавляемую сумму
    await client.query('UPDATE users SET balance_ton=balance_ton-$1 WHERE id=$2', [amount, user.id])

    let stake
    if (stakeId) {
      // FOR UPDATE + проверка ownership — блокируем стейк и подтверждаем что принадлежит юзеру
      const { rows: [existing] } = await client.query(
        "SELECT * FROM stakes WHERE id=$1 AND user_id=$2 AND status='active' FOR UPDATE",
        [stakeId, user.id]
      )
      if (existing) {
        // Считаем earned на сервере (единая формула)
        const currentEarned = calcEarned(existing.amount, existing.started_at, existing.earned)
        const { rows: [s] } = await client.query(
          `UPDATE stakes SET amount=amount+$1, earned=$2, started_at=NOW() WHERE id=$3 AND user_id=$4 AND status='active' RETURNING *`,
          [amount, currentEarned, stakeId, user.id]
        )
        stake = s
      }
    }

    if (!stake) {
      // Ищем любой активный стейк юзера, чтобы не создавать дубликаты
      const { rows: [anyActive] } = await client.query(
        "SELECT * FROM stakes WHERE user_id=$1 AND status='active' FOR UPDATE",
        [user.id]
      )
      if (anyActive) {
        const currentEarned = calcEarned(anyActive.amount, anyActive.started_at, anyActive.earned)
        const { rows: [s] } = await client.query(
          `UPDATE stakes SET amount=amount+$1, earned=$2, started_at=NOW() WHERE id=$3 RETURNING *`,
          [amount, currentEarned, anyActive.id]
        )
        stake = s
      } else {
        const { rows: [s] } = await client.query(
          `INSERT INTO stakes (user_id,amount,started_at,status) VALUES ($1,$2,NOW(),'active') RETURNING *`,
          [user.id, amount]
        )
        stake = s
      }
    }

    await client.query(
      `INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'stake',$2,'Пополнение стейка')`,
      [user.id, -parseFloat(amount)]
    )

    await client.query('COMMIT')
    res.json({ stake })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

// POST /api/staking/reinvest/:stakeId — реинвестиция дохода (earned считается на сервере)
router.post('/reinvest/:stakeId', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { stakeId } = req.params

    await client.query('BEGIN')

    // FOR UPDATE — блокируем стейк
    const { rows: [stake] } = await client.query(
      `SELECT s.*, u.id as uid FROM stakes s JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND u.telegram_id = $2 AND s.status = 'active'
       FOR UPDATE OF s`,
      [stakeId, tgId]
    )
    if (!stake) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Stake not found' }) }

    // Считаем earned на СЕРВЕРЕ (единая формула) — не доверяем клиенту
    const earned = calcEarned(stake.amount, stake.started_at, stake.earned)
    if (earned <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Нет дохода для реинвестиции' }) }

    const newAmount = parseFloat(stake.amount) + earned

    // Обновляем сумму стейка и сбрасываем время
    await client.query(
      `UPDATE stakes SET amount = $1, earned = 0, started_at = NOW() WHERE id = $2`,
      [newAmount, stakeId]
    )

    // Одна запись в историю
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1, 'reinvest', $2, 'Реинвестиция')`,
      [stake.uid, earned]
    )

    await client.query('COMMIT')
    res.json({ ok: true, earned, newAmount })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

export default router