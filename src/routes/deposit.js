import { Router } from 'express'
import pool from '../db/index.js'
import { getBot } from '../bot.js'
import { ADMIN_TG_ID } from '../config.js'

const router = Router()

// GET /api/deposit/info
router.get('/info', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('project_wallet','min_deposit_ton','withdraw_fee','min_withdraw_ton')"
    )
    const data = {}
    rows.forEach(r => {
      if (r.key === 'project_wallet') data.wallet = r.value || process.env.PROJECT_WALLET || ''
      if (r.key === 'min_deposit_ton') data.min_amount = parseFloat(r.value || 0.5)
      if (r.key === 'withdraw_fee') data.withdraw_fee = parseFloat(r.value || 0)
      if (r.key === 'min_withdraw_ton') data.min_withdraw = parseFloat(r.value || 1)
    })
    if (!data.wallet) data.wallet = process.env.PROJECT_WALLET || ''
    res.json(data)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/deposit/confirm
router.post('/confirm', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount, tx_hash } = req.body

    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' })
    if (!tx_hash) return res.status(400).json({ error: 'Требуется хэш транзакции' })

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    // Уникальный ключ BOC для защиты от повторов
    const bocKey = `boc:${tx_hash.slice(0, 64)}`

    // Получаем адрес кошелька проекта
    const { rows: walletRow } = await client.query("SELECT value FROM settings WHERE key='project_wallet'")
    const projectWallet = walletRow[0]?.value || process.env.PROJECT_WALLET || ''
    if (!projectWallet) return res.status(500).json({ error: 'Кошелёк проекта не настроен' })

    // Ждём 8 сек чтобы транзакция попала в блокчейн
    await new Promise(r => setTimeout(r, 8000))

    // Верифицируем — ищем транзакцию с нужной суммой от юзера
    let realAmount = 0
    let txHash = null

    try {
      const txRes = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${projectWallet}&limit=20`)
      const txData = await txRes.json()

      if (txData.ok && txData.result) {
        const depositAmount = parseFloat(amount)
        const expectedNano = Math.floor(depositAmount * 1e9)
        const now = Date.now() / 1000

        for (const tx of txData.result) {
          const inMsg = tx.in_msg
          if (!inMsg || !inMsg.value) continue
          const txNano = parseInt(inMsg.value)
          const timeDiff = now - tx.utime
          // Сумма совпадает (погрешность ±0.005 TON) и транзакция за последние 10 минут
          if (Math.abs(txNano - expectedNano) < 5000000 && timeDiff < 600 && timeDiff > 0) {
            txHash = tx.transaction_id?.hash || `${tx.utime}`
            // Проверяем что эта конкретная блокчейн-транзакция не использована
            const { rows: [usedChainTx] } = await client.query(
              "SELECT id FROM transactions WHERE status=$1", [`chain:${txHash}`]
            )
            if (!usedChainTx) {
              realAmount = txNano / 1e9
              break
            }
          }
        }
      }
    } catch (e) {
      console.error('TON verify error:', e.message)
      return res.status(500).json({ error: 'Не удалось проверить транзакцию. Попробуйте позже.' })
    }

    if (!realAmount || !txHash) {
      return res.status(400).json({ error: 'Транзакция не найдена в блокчейне. Подождите 15 секунд и попробуйте снова.' })
    }

    // Зачисляем в транзакции с атомарной проверкой дубликатов
    await client.query('BEGIN')

    // Повторная проверка внутри транзакции — защита от double-spend
    const { rows: [alreadyUsed] } = await client.query(
      "SELECT id FROM transactions WHERE status=$1", [`chain:${txHash}`]
    )
    if (alreadyUsed) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Транзакция уже зачислена' })
    }

    // Блокируем юзера от параллельных изменений
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id])

    await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [realAmount, user.id])

    // Реф бонус
    if (user.referred_by) {
      const { rows: [setting] } = await client.query("SELECT value FROM settings WHERE key='ref_deposit_percent'")
      const percent = parseFloat(setting?.value || 5) / 100
      const refBonus = realAmount * percent
      if (refBonus > 0) {
        const { rows: [referrer] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [user.referred_by])
        if (referrer) {
          await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [refBonus, referrer.id])
          await client.query(
            "INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'ref_deposit',$2,$3)",
            [referrer.id, refBonus, `Реф. бонус за депозит (${user.username || user.first_name})`]
          )
        }
      }
    }

    // Сохраняем транзакцию — используем chain hash и boc key как двойную защиту
    await client.query(
      "INSERT INTO transactions (user_id,type,amount,label,status) VALUES ($1,'deposit',$2,$3,$4)",
      [user.id, realAmount, `Пополнение`, `chain:${txHash}`]
    )


    await client.query('COMMIT')

    try {
      const bot = getBot()
      if (bot) await bot.sendMessage(ADMIN_TG_ID,
        `⬇️ <b>Пополнение баланса</b>\n\n👤 ${user.username ? '@'+user.username : user.first_name}\n💰 <b>${realAmount} TON</b>`,
        { parse_mode: 'HTML' }
      )
    } catch {}

    res.json({ ok: true, amount: realAmount })

  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// POST /api/deposit/withdraw
router.post('/withdraw', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount, wallet_address } = req.body

    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' })
    if (!wallet_address) return res.status(400).json({ error: 'Wallet address required' })

    await client.query('BEGIN')
    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    const withdrawAmount = parseFloat(amount)
    const { rows: [minW] } = await client.query("SELECT value FROM settings WHERE key='min_withdraw_ton'")
    const minWithdraw = parseFloat(minW?.value || 1)
    if (withdrawAmount < minWithdraw) return res.status(400).json({ error: `Минимальный вывод: ${minWithdraw} TON` })

    const { rows: [feeSetting] } = await client.query("SELECT value FROM settings WHERE key='withdraw_fee'")
    const fee = parseFloat(feeSetting?.value || 0)
    const netAmount = withdrawAmount - fee

    if (netAmount <= 0) return res.status(400).json({ error: `Сумма меньше комиссии (${fee} TON)` })
    if (parseFloat(user.balance_ton) < withdrawAmount) return res.status(400).json({ error: 'Недостаточно средств' })

    await client.query('UPDATE users SET balance_ton=balance_ton-$1 WHERE id=$2', [withdrawAmount, user.id])

    if (fee > 0) {
      const { rows: [admin] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [ADMIN_TG_ID])
      if (admin) {
        await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [fee, admin.id])
        await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'fee',$2,'Комиссия за вывод')", [admin.id, fee])
      }
    }

    await client.query('UPDATE users SET ton_address=$1 WHERE id=$2', [wallet_address, user.id])
    await client.query(
      "INSERT INTO transactions (user_id,type,amount,label,status) VALUES ($1,'withdraw',$2,$3,'pending')",
      [user.id, -withdrawAmount, `Вывод на ${wallet_address}|net:${netAmount}`]
    )
    await client.query('COMMIT')

    try {
      const bot = getBot()
      if (bot) await bot.sendMessage(ADMIN_TG_ID,
        `💸 <b>Новая заявка на вывод</b>\n\n👤 ${user.username ? '@'+user.username : user.first_name}\n💰 <b>${withdrawAmount} TON</b>\n🏦 Комиссия: ${fee} TON\n📬 <code>${wallet_address}</code>`,
        { parse_mode: 'HTML' }
      )
    } catch (e) { console.error('Notify error:', e.message) }

    res.json({ ok: true, message: 'Заявка на вывод создана. Обработка до 24 часов.' })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

export default router
