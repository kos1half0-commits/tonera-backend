import { Router } from 'express'
import pool from '../db/index.js'
import crypto from 'crypto'

const router = Router()

router.post('/login', async (req, res) => {
  const client = await pool.connect()
  try {
    const tg = req.telegramUser
    if (!tg?.id) return res.status(401).json({ error: 'No user' })

    // Проверка тех обслуживания
    const { rows: [maint] } = await client.query("SELECT value FROM settings WHERE key='maintenance'")
    if (maint?.value === '1' && Number(tg.id) !== parseInt(process.env.ADMIN_TG_ID)) {
      return res.status(503).json({ error: '🔧 Технические работы. Скоро вернёмся!' })
    }

    const refCode = crypto.randomBytes(4).toString('hex')

    // Upsert user
    const { rows: [user] } = await client.query(
      `INSERT INTO users (telegram_id, username, first_name, last_name, ref_code)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (telegram_id) DO UPDATE SET
         username   = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name  = EXCLUDED.last_name
       RETURNING *`,
      [tg.id, tg.username, tg.first_name, tg.last_name, refCode]
    )

    // Применяем pending_ref если есть и юзер ещё не был реферован
    if (user.pending_ref && !user.referred_by) {
      try {
        await client.query('BEGIN')

        const { rows: [referrer] } = await client.query(
          'SELECT * FROM users WHERE ref_code=$1', [user.pending_ref]
        )

        if (referrer && referrer.telegram_id !== user.telegram_id) {
          const { rows: [existing] } = await client.query(
            'SELECT id FROM referrals WHERE referred_id=$1', [user.id]
          )

          if (!existing) {
            await client.query(
              'INSERT INTO referrals (referrer_id,referred_id) VALUES ($1,$2)',
              [referrer.id, user.id]
            )
            await client.query(
              'UPDATE users SET referred_by=$1, referral_count=referral_count+1 WHERE id=$2',
              [referrer.telegram_id, referrer.id]
            )
            await client.query(
              'UPDATE users SET referred_by=$1 WHERE id=$2',
              [referrer.telegram_id, user.id]
            )

            // Бонус из настроек
            const { rows: [s] } = await client.query(
              "SELECT value FROM settings WHERE key='ref_register_bonus'"
            )
            const bonus = parseFloat(s?.value || 0.5)
            if (bonus > 0) {
              await client.query(
                'UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2',
                [bonus, referrer.id]
              )
              await client.query(
                `INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'reward',$2,$3)`,
                [referrer.id, bonus, `Реф. бонус за регистрацию (${tg.username || tg.first_name})`]
              )
            }
          }
        }

        // Очищаем pending_ref
        await client.query('UPDATE users SET pending_ref=NULL WHERE id=$1', [user.id])
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK')
        console.error('Ref apply error:', e)
      }
    }

    // Получаем свежие данные
    const { rows: [freshUser] } = await client.query(
      'SELECT * FROM users WHERE id=$1', [user.id]
    )

    // Проверка блокировки
    if (freshUser.is_blocked) {
      return res.status(403).json({ error: '🚫 Ваш аккаунт заблокирован. Обратитесь к администратору.' })
    }

    const { rows: [adminCheck] } = await pool.query(
      'SELECT id FROM admins WHERE telegram_id=$1', [freshUser.telegram_id]
    ).catch(() => ({ rows: [] }))
    const isAdmin = String(freshUser.telegram_id) === String(process.env.ADMIN_TG_ID) || !!adminCheck
    res.json({ user: { ...freshUser, is_admin: isAdmin } })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

export default router
