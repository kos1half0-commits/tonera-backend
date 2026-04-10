import { Router } from 'express'
import pool from '../db/index.js'
import { getBot } from '../bot.js'

const router = Router()

// POST /api/promo/activate — активировать промокод
router.post('/activate', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { code } = req.body
    if (!code?.trim()) return res.status(400).json({ error: 'Введите промокод' })

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' })

    const { rows: [promo] } = await client.query(
      'SELECT * FROM promo_codes WHERE UPPER(code)=UPPER($1) AND active=true', [code.trim()]
    )
    if (!promo) return res.status(400).json({ error: 'Промокод не найден или недействителен' })
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) return res.status(400).json({ error: 'Промокод истёк' })
    if (promo.uses >= promo.max_uses) return res.status(400).json({ error: 'Промокод исчерпан' })

    // Проверяем что юзер ещё не использовал
    const { rows: [used] } = await client.query(
      'SELECT id FROM promo_uses WHERE promo_id=$1 AND user_id=$2', [promo.id, user.id]
    )
    if (used) return res.status(400).json({ error: 'Вы уже использовали этот промокод' })

    // Для партнёрских промокодов — проверяем подписку на канал
    if (promo.type === 'partner' && promo.channel_name) {
      const bot = getBot()
      if (bot) {
        try {
          const chName = promo.channel_name.replace('@', '')
          const member = await bot.getChatMember('@' + chName, tgId)
          if (!['member', 'administrator', 'creator'].includes(member.status)) {
            return res.status(400).json({ error: `Подпишитесь на канал @${chName} чтобы активировать этот промокод` })
          }
        } catch (e) {
          return res.status(400).json({ error: `Подпишитесь на канал @${promo.channel_name} для активации` })
        }
      }
    }

    await client.query('BEGIN')
    await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [promo.amount, user.id])
    await client.query('UPDATE promo_codes SET uses=uses+1 WHERE id=$1', [promo.id])
    await client.query('INSERT INTO promo_uses (promo_id, user_id) VALUES ($1,$2)', [promo.id, user.id])
    await client.query(
      "INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'bonus',$2,$3)",
      [user.id, promo.amount, `🎁 Промокод ${promo.code}`]
    )
    await client.query('COMMIT')

    res.json({ ok: true, amount: promo.amount, code: promo.code })
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    if (e.code === '23505') return res.status(400).json({ error: 'Вы уже использовали этот промокод' })
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// GET /api/promo/all — все промокоды (админ)
router.get('/all', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC')
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/promo/create — создать (админ)
router.post('/create', async (req, res) => {
  try {
    const { code, amount, max_uses, expires_at } = req.body
    if (!code?.trim() || !amount) return res.status(400).json({ error: 'Заполните все поля' })
    const expiresVal = expires_at ? new Date(expires_at) : null
    const { rows: [p] } = await pool.query(
      'INSERT INTO promo_codes (code, amount, max_uses, expires_at) VALUES (UPPER($1),$2,$3,$4) RETURNING *',
      [code.trim(), parseFloat(amount), parseInt(max_uses) || 1, expiresVal]
    )
    res.json({ ok: true, promo: p })
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Такой промокод уже существует' })
    res.status(500).json({ error: e.message })
  }
})

// PUT /api/promo/:id/edit — редактировать промокод (админ)
router.put('/:id/edit', async (req, res) => {
  try {
    const { code, amount, max_uses, expires_at } = req.body
    const fields = []
    const vals = []
    let idx = 1
    if (code !== undefined) { fields.push(`code=UPPER($${idx++})`); vals.push(code.trim()) }
    if (amount !== undefined) { fields.push(`amount=$${idx++}`); vals.push(parseFloat(amount)) }
    if (max_uses !== undefined) { fields.push(`max_uses=$${idx++}`); vals.push(parseInt(max_uses)) }
    if (expires_at !== undefined) { fields.push(`expires_at=$${idx++}`); vals.push(expires_at ? new Date(expires_at) : null) }
    if (fields.length === 0) return res.status(400).json({ error: 'Нечего обновлять' })
    vals.push(req.params.id)
    await pool.query(`UPDATE promo_codes SET ${fields.join(',')} WHERE id=$${idx}`, vals)
    res.json({ ok: true })
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Такой промокод уже существует' })
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/promo/:id — удалить (админ)
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM promo_uses WHERE promo_id=$1', [req.params.id])
    await pool.query('DELETE FROM promo_codes WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// PUT /api/promo/:id/toggle — вкл/откл
router.put('/:id/toggle', async (req, res) => {
  try {
    await pool.query('UPDATE promo_codes SET active=NOT active WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/promo/partner-list — каналы партнёров (без промокодов)
router.get('/partner-list', async (req, res) => {
  try {
    // Получаем уникальные каналы у которых есть активные промокоды
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (pc.channel_name)
        pc.channel_name, pc.amount, pc.expires_at,
        p.channel_url,
        u.username, u.first_name
      FROM promo_codes pc
      LEFT JOIN partnerships p ON pc.partnership_id = p.id AND pc.partnership_id > 0
      LEFT JOIN users u ON p.user_id = u.id
      WHERE pc.active = true 
        AND pc.type = 'partner'
        AND (pc.expires_at IS NULL OR pc.expires_at > NOW())
        AND pc.uses < pc.max_uses
        AND pc.channel_name IS NOT NULL
      ORDER BY pc.channel_name, pc.created_at DESC
    `)

    const result = rows.map(r => ({
      channel_url: r.channel_url || (r.channel_name ? `https://t.me/${r.channel_name.replace(/^@/, '')}` : null),
      channel_name: r.channel_name,
      reward: r.amount,
      expires_at: r.expires_at,
      username: r.username,
      first_name: r.first_name,
    }))

    res.json(result)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
