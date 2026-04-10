import { Router } from 'express'
import pool from '../db/index.js'

const router = Router()

// GET /api/ads?page=home — получить активные баннеры для страницы
router.get('/', async (req, res) => {
  try {
    const page = req.query.page || 'home'
    await pool.query("UPDATE ads SET active=false WHERE expires_at IS NOT NULL AND expires_at < NOW() AND active=true")
    const { rows } = await pool.query(
      `SELECT id, title, text, image_url, link, expires_at FROM ads WHERE active=true AND pages LIKE $1 ORDER BY created_at DESC`,
      [`%${page}%`]
    )
    // Increment views
    if (rows.length > 0) {
      const ids = rows.map(r => r.id)
      await pool.query(`UPDATE ads SET views = views + 1 WHERE id = ANY($1)`, [ids]).catch(() => { })
    }
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/ads/click — зафиксировать клик по баннеру
router.post('/click', async (req, res) => {
  try {
    const { ad_id } = req.body
    if (!ad_id) return res.status(400).json({ error: 'ad_id required' })
    const tgId = req.telegramUser?.id
    let userId = null
    if (tgId) {
      const { rows: [u] } = await pool.query('SELECT id FROM users WHERE telegram_id=$1', [tgId])
      userId = u?.id || null
    }
    await pool.query('UPDATE ads SET clicks = clicks + 1 WHERE id=$1', [ad_id])
    await pool.query('INSERT INTO ad_clicks (ad_id, user_id) VALUES ($1,$2)', [ad_id, userId]).catch(() => { })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/ads/all — все баннеры (для админа) с кликами/просмотрами
router.get('/all', async (req, res) => {
  try {
    await pool.query("UPDATE ads SET active=false WHERE expires_at IS NOT NULL AND expires_at < NOW() AND active=true")
    const { rows } = await pool.query(
      `SELECT a.*, u.username, u.first_name,
        COALESCE(a.clicks,0) as clicks, COALESCE(a.views,0) as views
       FROM ads a LEFT JOIN users u ON a.user_id = u.id
       ORDER BY a.created_at DESC`
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/ads — создать баннер
router.post('/', async (req, res) => {
  try {
    const { title, text, image_url, link, pages, expires_at } = req.body
    const expiresVal = expires_at ? new Date(expires_at) : null
    const { rows: [ad] } = await pool.query(
      'INSERT INTO ads (title, text, image_url, link, pages, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [title || '', text || '', image_url || null, link || null, pages || 'home,tasks,games,staking,miner,wallet', expiresVal]
    )
    res.json({ ok: true, ad })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// PUT /api/ads/:id — обновить
router.put('/:id', async (req, res) => {
  try {
    const { title, text, image_url, link, pages, active, expires_at } = req.body
    const fields = ['title=$1', 'text=$2', 'image_url=$3', 'link=$4', 'pages=$5', 'active=$6']
    const vals = [title, text, image_url || null, link || null, pages, active]
    let idx = 7
    if (expires_at !== undefined) {
      fields.push(`expires_at=$${idx++}`)
      vals.push(expires_at ? new Date(expires_at) : null)
    }
    vals.push(req.params.id)
    await pool.query(`UPDATE ads SET ${fields.join(',')} WHERE id=$${idx}`, vals)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/ads/:id — удалить
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM ads WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})


// GET /api/ads/prices — получить цены
router.get('/prices', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT key,value FROM settings WHERE key IN ('ad_price_week','ad_price_2weeks','ad_price_month')")
    const s = {}
    rows.forEach(r => s[r.key] = parseFloat(r.value))
    res.json({ week: s.ad_price_week || 5, twoWeeks: s.ad_price_2weeks || 9, month: s.ad_price_month || 15 })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/ads/order — заказать рекламу (от юзера)
router.post('/order', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    const { title, text, image_url, link, pages, budget, duration, tx_hash } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'Введите заголовок' })
    if (!tx_hash) return res.status(400).json({ error: 'Требуется оплата' })

    const { rows: [usedTx] } = await pool.query("SELECT id FROM transactions WHERE status=$1", [`ad_tx:${tx_hash}`])
    if (usedTx) return res.status(400).json({ error: 'Транзакция уже использована' })

    await pool.query("INSERT INTO transactions (user_id,type,amount,label,status) VALUES ($1,'ad_payment',$2,$3,$4)",
      [user.id, -parseFloat(budget) || 0, `📣 Реклама: ${title}`, `ad_tx:${tx_hash}`])

    const { rows: [order] } = await pool.query(
      'INSERT INTO ad_orders (user_id, title, text, image_url, link, pages, budget) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [user.id, title, text || '', image_url || null, link || '', pages || 'home', parseFloat(budget) || 0]
    )

    try {
      const { getBot } = await import('../bot.js')
      const { ADMIN_TG_ID } = await import('../config.js')
      const bot = getBot()
      if (bot) await bot.sendMessage(ADMIN_TG_ID,
        `📣 <b>Новая заявка на рекламу</b>\n\n👤 ${user.username ? '@' + user.username : user.first_name}\n📋 ${title}\n💰 Бюджет: ${budget} TON\n📍 Страницы: ${pages}`,
        { parse_mode: 'HTML' }
      )
    } catch { }

    res.json({ ok: true, order })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/ads/orders — все заявки (для админа)
router.get('/orders', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, u.username, u.first_name, u.telegram_id
       FROM ad_orders o JOIN users u ON o.user_id=u.id
       ORDER BY o.created_at DESC`
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// PUT /api/ads/orders/:id — одобрить/отклонить заявку
router.put('/orders/:id', async (req, res) => {
  try {
    const { status, duration_days } = req.body
    const { rows: [order] } = await pool.query(
      'UPDATE ad_orders SET status=$1 WHERE id=$2 RETURNING *',
      [status, req.params.id]
    )

    if (status === 'approved' && order) {
      const days = parseInt(duration_days) || 14
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
      await pool.query(
        'INSERT INTO ads (title, text, image_url, link, pages, user_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [order.title, order.text, order.image_url, order.link, order.pages, order.user_id, expiresAt]
      )
    }

    try {
      const { getBot } = await import('../bot.js')
      const bot = getBot()
      const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id=$1', [order.user_id])
      if (bot && user) {
        const msg = status === 'approved'
          ? `✅ Ваша реклама <b>${order.title}</b> одобрена и опубликована!`
          : `❌ Ваша реклама <b>${order.title}</b> отклонена.`
        await bot.sendMessage(user.telegram_id, msg, { parse_mode: 'HTML' })
      }
    } catch { }

    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/ads/my-stats — статистика баннеров юзера
router.get('/my-stats', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query('SELECT id FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.json({ ads: [] })

    const { rows } = await pool.query(
      `SELECT id, title, active, expires_at,
        COALESCE(clicks,0) as clicks, COALESCE(views,0) as views, created_at
       FROM ads WHERE user_id=$1 ORDER BY created_at DESC`,
      [user.id]
    )
    res.json({ ads: rows })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/ads/partner-banner — бесплатный баннер партнёра на 2 недели
router.post('/partner-banner', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' })

    const { rows: [p] } = await pool.query(
      "SELECT * FROM partnerships WHERE user_id=$1 AND status='approved'", [user.id]
    )
    if (!p) return res.status(400).json({ error: 'У вас нет активного партнёрства' })

    const { rows: [existing] } = await pool.query(
      "SELECT * FROM ads WHERE partnership_id=$1 AND type='partner' AND active=true", [p.id]
    )
    if (existing) return res.status(400).json({ error: 'У вас уже есть активный баннер', ad: existing })

    const { rows: [used] } = await pool.query(
      "SELECT * FROM ads WHERE partnership_id=$1 AND type='partner'", [p.id]
    )
    if (used) return res.status(400).json({ error: 'Бесплатный баннер уже был использован для этого партнёрства' })

    const { title, text, image_url, link, pages } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'Введите заголовок' })

    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)

    const { rows: [ad] } = await pool.query(
      `INSERT INTO ads (title, text, image_url, link, pages, type, partnership_id, user_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,'partner',$6,$7,$8) RETURNING *`,
      [title.trim(), text || '', image_url || null, link || p.channel_url, pages || 'home,tasks,games,staking,miner,wallet', p.id, user.id, expiresAt]
    )

    try {
      const { getBot } = await import('../bot.js')
      const { ADMIN_TG_ID } = await import('../config.js')
      const bot = getBot()
      if (bot) await bot.sendMessage(ADMIN_TG_ID,
        `📢 <b>Партнёр создал бесплатный баннер</b>\n\n👤 ${user.username ? '@' + user.username : user.first_name}\n📋 ${title}\n📢 Канал: ${p.channel_url}\n⏰ Истекает: ${expiresAt.toLocaleDateString('ru')}`,
        { parse_mode: 'HTML' }
      )
    } catch { }

    res.json({ ok: true, ad })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/ads/my-banner — получить свой партнёрский баннер
router.get('/my-banner', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.json({ banner: null })

    const { rows: [p] } = await pool.query(
      "SELECT * FROM partnerships WHERE user_id=$1 AND status='approved'", [user.id]
    )
    if (!p) return res.json({ banner: null })

    const { rows: [banner] } = await pool.query(
      "SELECT * FROM ads WHERE partnership_id=$1 AND type='partner' ORDER BY created_at DESC LIMIT 1", [p.id]
    )
    res.json({ banner: banner || null, can_create: !banner })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/ads/adsgram-reward — начислить награду за просмотр рекламы
router.post('/adsgram-reward', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    // Get settings
    const { rows: settings } = await client.query(
      "SELECT key,value FROM settings WHERE key IN ('adsgram_reward','adsgram_daily_limit')"
    )
    const s = {}
    settings.forEach(r => s[r.key] = r.value)
    const reward = parseFloat(s.adsgram_reward) || 0.0001
    const dailyLimit = parseInt(s.adsgram_daily_limit) || 10

    // Check daily limit
    const { rows: [{ count }] } = await client.query(
      "SELECT COUNT(*) as count FROM transactions WHERE user_id=$1 AND type='ad_reward' AND created_at > NOW() - INTERVAL '24 hours'",
      [user.id]
    )
    if (parseInt(count) >= dailyLimit) {
      return res.status(400).json({ error: `Лимит ${dailyLimit} просмотров в день исчерпан` })
    }

    await client.query('BEGIN')
    await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [reward, user.id])
    await client.query(
      "INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'ad_reward',$2,'🎬 Просмотр рекламы')",
      [user.id, reward]
    )
    await client.query('COMMIT')

    res.json({ ok: true, reward })
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { }
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// GET /api/ads/adsgram-info — всё инфо для страницы рекламы
router.get('/adsgram-info', async (req, res) => {
  try {
    const tgId = req.telegramUser?.id

    // Get settings
    const { rows: settings } = await pool.query(
      "SELECT key,value FROM settings WHERE key IN ('adsgram_block_id','adsgram_reward','adsgram_daily_limit')"
    )
    const s = {}
    settings.forEach(r => s[r.key] = r.value)
    const blockId = s.adsgram_block_id || ''
    const reward = parseFloat(s.adsgram_reward) || 0.0001
    const dailyLimit = parseInt(s.adsgram_daily_limit) || 10

    let todayCount = 0
    let totalEarned = 0

    if (tgId) {
      const { rows: [user] } = await pool.query('SELECT id FROM users WHERE telegram_id=$1', [tgId])
      if (user) {
        const { rows: [{ count }] } = await pool.query(
          "SELECT COUNT(*) as count FROM transactions WHERE user_id=$1 AND type='ad_reward' AND created_at > NOW() - INTERVAL '24 hours'",
          [user.id]
        )
        todayCount = parseInt(count)

        const { rows: [{ total }] } = await pool.query(
          "SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=$1 AND type='ad_reward'",
          [user.id]
        )
        totalEarned = parseFloat(total)
      }
    }

    res.json({ blockId, reward, dailyLimit, todayCount, totalEarned })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router

