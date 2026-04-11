import { Router } from 'express'
import pool from '../db/index.js'
import { ADMIN_TG_ID, BOT_USERNAME } from '../config.js'
import { getBot } from '../bot.js'

const router = Router()

// Partnership levels
const LEVELS = [
  { name: 'Bronze',  min: 0,     color: '#cd7f32', emoji: '🥉', settingKey: 'partnership_lvl_bronze_execs', defaultExecs: 100 },
  { name: 'Silver',  min: 5000,  color: '#c0c0c0', emoji: '🥈', settingKey: 'partnership_lvl_silver_execs', defaultExecs: 500 },
  { name: 'Gold',    min: 20000, color: '#ffd700', emoji: '🥇', settingKey: 'partnership_lvl_gold_execs', defaultExecs: 2000 },
  { name: 'Diamond', min: 50000, color: '#b9f2ff', emoji: '💎', settingKey: 'partnership_lvl_diamond_execs', defaultExecs: 10000 },
]

function getLevel(subscriberCount, settings = {}) {
  let level = LEVELS[0]
  for (const l of LEVELS) {
    if (subscriberCount >= l.min) level = l
  }
  const nextLevel = LEVELS[LEVELS.indexOf(level) + 1] || null
  const maxExecs = parseInt(settings[level.settingKey] || level.defaultExecs)
  return { ...level, nextLevel, subscribers: subscriberCount, maxExecs }
}

// Load level settings from DB
async function loadLevelSettings(client) {
  const q = client || pool
  const { rows } = await q.query("SELECT key, value FROM settings WHERE key LIKE 'partnership_lvl_%'")
  const s = {}
  rows.forEach(r => s[r.key] = r.value)
  return s
}

// Check channel subscribers
async function checkChannelSubs(channelUrl) {
  try {
    const match = channelUrl.match(/t\.me\/([^/?]+)/)
    if (!match) return { ok: false, error: 'Неверный формат ссылки на канал' }
    const channelName = match[1]
    const bot = getBot()
    if (!bot) return { ok: false, count: 0 }
    const chat = await bot.getChat('@' + channelName).catch(() => null)
    if (!chat) return { ok: false, error: 'Канал не найден или он приватный' }
    const count = await bot.getChatMemberCount('@' + channelName).catch(() => 0)
    return { ok: true, count, title: chat.title || channelName }
  } catch (e) {
    return { ok: false, error: 'Не удалось проверить канал: ' + e.message }
  }
}

// Check post contains bot link
async function checkPost(postUrl) {
  try {
    const match = postUrl.match(/t\.me\/([^/]+)\/(\d+)/)
    if (!match) return { ok: false, error: 'Неверный формат ссылки. Нужно: https://t.me/channelname/123' }

    const [, channelName, postId] = match
    const bot = getBot()
    if (!bot) return { ok: false, error: 'Бот недоступен' }

    const msg = await bot.forwardMessage(ADMIN_TG_ID, '@' + channelName, parseInt(postId)).catch(() => null)
    if (!msg) {
      return { ok: false, error: 'Не удалось получить пост. Убедитесь что канал публичный' }
    }

    const text = (msg.text || msg.caption || '').toLowerCase()
    const botLink = (BOT_USERNAME || '').toLowerCase().replace('@', '')
    const hasBotLink = text.includes('t.me/' + botLink) || text.includes('@' + botLink)

    try { await bot.deleteMessage(ADMIN_TG_ID, msg.message_id) } catch {}

    if (!hasBotLink) {
      return { ok: false, error: `Пост не содержит ссылку на бота. Добавьте t.me/${botLink} в пост` }
    }

    return { ok: true, channelName }
  } catch (e) {
    return { ok: false, error: 'Ошибка проверки: ' + e.message }
  }
}

// Helper: check if user is admin
async function isAdmin(tgId) {
  if (Number(tgId) === ADMIN_TG_ID) return true
  const { rows } = await pool.query('SELECT 1 FROM admins WHERE telegram_id = $1', [tgId])
  return rows.length > 0
}

// GET /api/partnership/status — public status
router.get('/status', async (req, res) => {
  try {
    const { rows: [s] } = await pool.query("SELECT value FROM settings WHERE key='partnership_enabled'")
    res.json({ value: s?.value ?? '1' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/partnership/my
router.get('/my', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    const { rows: [p] } = await pool.query('SELECT * FROM partnerships WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [user.id])
    const { rows: allSettings } = await pool.query(
      "SELECT key,value FROM settings WHERE key LIKE 'partnership_%' OR key LIKE 'partner_promo_%'"
    )
    const cfg = {}
    allSettings.forEach(r => cfg[r.key] = r.value)

    const min_subs = parseInt(cfg['partnership_min_subs'] || 1000)
    const enabled = cfg['partnership_enabled'] || '1'

    // Check cooldown for cancelled partnerships
    let cooldown_until = null
    if (p?.status === 'cancelled' && p.cancelled_at) {
      const cooldownEnd = new Date(new Date(p.cancelled_at).getTime() + 30 * 24 * 60 * 60 * 1000)
      if (cooldownEnd > new Date()) {
        cooldown_until = cooldownEnd.toISOString()
      }
    }

    // Get level info for approved partners + monthly renewal
    let level = null
    let taskStats = null
    let renewsAt = null
    if (p?.status === 'approved' && p.channel_url) {
      const subsCheck = await checkChannelSubs(p.channel_url).catch(() => ({ ok: false, count: 0 }))
      const subCount = subsCheck.ok ? subsCheck.count : 0
      level = getLevel(subCount, cfg)

      // Monthly renewal check — reset executions every 30 days
      if (p.task_id) {
        const lastRenewed = p.last_renewed_at ? new Date(p.last_renewed_at) : new Date(p.created_at)
        const daysSinceRenewal = (Date.now() - lastRenewed.getTime()) / (24 * 60 * 60 * 1000)
        const renewalDate = new Date(lastRenewed.getTime() + 30 * 24 * 60 * 60 * 1000)
        renewsAt = renewalDate.toISOString()

        if (daysSinceRenewal >= 30) {
          // Time to renew! Reset executions, update max based on current level
          await pool.query(
            'UPDATE tasks SET executions = 0, max_executions = $1, active = true WHERE id = $2',
            [level.maxExecs, p.task_id]
          )
          await pool.query(
            'UPDATE partnerships SET last_renewed_at = NOW() WHERE id = $1',
            [p.id]
          )
          renewsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
          console.log(`[Partnership #${p.id}] Monthly renewal: reset executions, maxExecs=${level.maxExecs}`)
        }

        // Get task stats (after possible renewal)
        const { rows: [t] } = await pool.query('SELECT executions, max_executions, reward, active FROM tasks WHERE id=$1', [p.task_id])
        if (t) {
          taskStats = {
            executions: t.executions,
            max_executions: t.max_executions,
            reward: parseFloat(t.reward),
            active: t.active,
            total_spent: parseFloat(t.reward) * (t.executions || 0),
          }
        }
      }
    }

    // Build levels config for landing page (always returned)
    const levelsConfig = LEVELS.map(l => ({
      name: l.name,
      emoji: l.emoji,
      color: l.color,
      min: l.min,
      maxExecs: parseInt(cfg[l.settingKey] || l.defaultExecs),
      promoReward: parseFloat(cfg[`partner_promo_${l.name.toLowerCase()}_reward`] || '0.01'),
      promoUses: parseInt(cfg[`partner_promo_${l.name.toLowerCase()}_uses`] || '10'),
    }))

    res.json({
      partnership: p || null,
      referral_count: user.referral_count,
      min_subs,
      bot_username: BOT_USERNAME,
      ref_code: user.ref_code,
      enabled,
      level,
      taskStats,
      cooldown_until,
      levels: levelsConfig,
      renewsAt,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/partnership/check-channel — step 1: check if channel qualifies
router.post('/check-channel', async (req, res) => {
  try {
    const { channel_url } = req.body
    if (!channel_url?.trim()) return res.status(400).json({ error: 'Укажите ссылку на канал' })

    const result = await checkChannelSubs(channel_url.trim())
    if (!result.ok) return res.json(result)

    const { rows: [s] } = await pool.query("SELECT value FROM settings WHERE key='partnership_min_subs'")
    const minSubs = parseInt(s?.value || 1000)

    if (result.count < minSubs) {
      return res.json({ ok: false, error: `Недостаточно подписчиков: ${result.count}. Минимум: ${minSubs}` })
    }

    res.json({ ok: true, count: result.count, title: result.title, minSubs })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/partnership/check-bot-admin — step 2: check bot is admin with post rights
router.post('/check-bot-admin', async (req, res) => {
  try {
    const { channel_url } = req.body
    if (!channel_url?.trim()) return res.status(400).json({ error: 'Укажите ссылку на канал' })

    const match = channel_url.trim().match(/t\.me\/([^/?]+)/)
    if (!match) return res.json({ ok: false, error: 'Неверный формат ссылки на канал' })

    const bot = getBot()
    if (!bot) return res.json({ ok: false, error: 'Бот недоступен' })

    const channelName = '@' + match[1]
    const botInfo = await bot.getMe()
    const member = await bot.getChatMember(channelName, botInfo.id).catch(() => null)

    if (!member || !['administrator', 'creator'].includes(member.status)) {
      return res.json({ ok: false, error: `Бот @${botInfo.username} не является администратором канала. Добавьте его как админа.` })
    }

    // Check posting rights
    if (!member.can_post_messages && member.status !== 'creator') {
      return res.json({ ok: false, error: `Бот является админом, но не имеет права публикации постов. Включите "Публикация сообщений" в правах бота.` })
    }

    res.json({ ok: true, bot_username: botInfo.username })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/partnership/check — check post contains bot link
router.post('/check', async (req, res) => {
  try {
    const { post_url } = req.body
    if (!post_url?.trim()) return res.status(400).json({ error: 'Укажите ссылку на пост' })
    const result = await checkPost(post_url.trim())
    res.json(result)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/partnership/generate-promo — generate partner promo code based on level
router.post('/generate-promo', async (req, res) => {
  try {
    const { channel_url } = req.body
    if (!channel_url?.trim()) return res.status(400).json({ error: 'Укажите канал' })

    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])

    // Get subscriber count to determine level
    const subsCheck = await checkChannelSubs(channel_url.trim())
    const subCount = subsCheck.ok ? subsCheck.count : 0

    // Determine level name
    const levelNames = ['bronze', 'silver', 'gold', 'diamond']
    const levelMins = [0, 5000, 20000, 50000]
    let lvlName = 'bronze'
    for (let i = 0; i < levelMins.length; i++) {
      if (subCount >= levelMins[i]) lvlName = levelNames[i]
    }

    // Load level-specific promo settings
    const { rows: settings } = await pool.query(
      "SELECT key, value FROM settings WHERE key LIKE 'partner_promo_%'"
    )
    const s = {}
    settings.forEach(r => s[r.key] = r.value)

    const reward = parseFloat(s[`partner_promo_${lvlName}_reward`] || '0.01')
    const maxUses = parseInt(s[`partner_promo_${lvlName}_uses`] || '10')
    const expiryHours = parseInt(s['partner_promo_expiry_hours'] || '24')

    // Generate unique code
    const prefix = (user.username || 'P').toUpperCase().slice(0, 4)
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase()
    const code = `${prefix}-${rand}`
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000)

    // Extract channel name
    const chMatch = channel_url.trim().match(/t\.me\/([^/?]+)/)
    const chName = chMatch ? '@' + chMatch[1] : channel_url.trim()

    const { rows: [promo] } = await pool.query(
      `INSERT INTO promo_codes (code, amount, max_uses, active, partnership_id, expires_at, channel_name, type)
       VALUES (UPPER($1), $2, $3, true, -1, $4, $5, 'partner') RETURNING *`,
      [code, reward, maxUses, expiresAt, chName]
    )

    res.json({
      ok: true,
      promo: {
        code: promo.code,
        amount: reward,
        max_uses: maxUses,
        expires_at: expiresAt.toISOString(),
        level: lvlName,
        channel_name: chName,
      }
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/partnership/publish-promo — publish promo post to channel via bot
router.post('/publish-promo', async (req, res) => {
  try {
    const { channel_url, text } = req.body
    if (!channel_url?.trim() || !text?.trim()) return res.status(400).json({ error: 'Заполните все поля' })

    const match = channel_url.trim().match(/t\.me\/([^/?]+)/)
    if (!match) return res.status(400).json({ error: 'Неверный формат ссылки' })

    const bot = getBot()
    if (!bot) return res.status(500).json({ error: 'Бот недоступен' })

    const channelName = '@' + match[1]

    // Send photo with caption — use logo.png from app
    let msg
    const logoUrl = (process.env.APP_URL || 'https://tonera.io') + '/logo.png'
    try {
      msg = await bot.sendPhoto(channelName, logoUrl, { caption: text, parse_mode: 'HTML' })
    } catch (e) {
      // Fallback to text only
      try {
        msg = await bot.sendMessage(channelName, text, { parse_mode: 'HTML' })
      } catch (e2) {
        return res.status(500).json({ error: 'Не удалось опубликовать: ' + e2.message })
      }
    }

    const postUrl = `https://t.me/${match[1]}/${msg.message_id}`
    res.json({ ok: true, post_url: postUrl, message_id: msg.message_id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/partnership/apply — atomic with race condition prevention
router.post('/apply', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { channel_url, post_url } = req.body
    if (!channel_url?.trim() || !post_url?.trim())
      return res.status(400).json({ error: 'Заполните все поля' })

    await client.query('BEGIN')

    // Check partnership_enabled mode
    const { rows: [enabledRow] } = await client.query("SELECT value FROM settings WHERE key='partnership_enabled'")
    const mode = enabledRow?.value || '1'
    if (mode === '0') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Партнёрство временно отключено' }) }

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    const admin = await isAdmin(tgId)

    if (mode === '2' && !admin) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Партнёрство доступно только для администраторов' }) }

    // FOR UPDATE to prevent race condition duplicates
    const { rows: [existing] } = await client.query(
      "SELECT * FROM partnerships WHERE user_id=$1 AND status IN ('pending','approved') FOR UPDATE", [user.id]
    )
    if (existing) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Заявка уже подана' }) }

    // Check 30-day cooldown after cancellation
    const { rows: [cancelled] } = await client.query(
      "SELECT * FROM partnerships WHERE user_id=$1 AND status='cancelled' AND cancelled_at > NOW() - INTERVAL '30 days' ORDER BY cancelled_at DESC LIMIT 1", [user.id]
    )
    if (cancelled) {
      const cooldownEnd = new Date(new Date(cancelled.cancelled_at).getTime() + 30 * 24 * 60 * 60 * 1000)
      await client.query('ROLLBACK')
      return res.status(400).json({
        error: `Повторная заявка возможна после ${cooldownEnd.toLocaleDateString('ru', {day:'numeric',month:'long',year:'numeric'})}`,
        cooldown_until: cooldownEnd.toISOString()
      })
    }

    // Check subscribers
    const { rows: minSubsRow } = await client.query("SELECT value FROM settings WHERE key='partnership_min_subs'")
    const minSubs = parseInt(minSubsRow[0]?.value || 1000)
    const subsCheck = await checkChannelSubs(channel_url.trim())
    if (!subsCheck.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: subsCheck.error }) }
    if (subsCheck.count < minSubs) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Недостаточно подписчиков. Нужно минимум ${minSubs}, у вас ${subsCheck.count}` })
    }

    // Check post
    const check = await checkPost(post_url.trim())
    if (!check.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: check.error }) }

    const { rows: [p] } = await client.query(
      'INSERT INTO partnerships (user_id, channel_url, channel_name, post_url) VALUES ($1,$2,$3,$4) RETURNING *',
      [user.id, channel_url.trim(), check.channelName || '', post_url.trim()]
    )

    await client.query('COMMIT')

    try {
      const bot = getBot()
      if (bot) await bot.sendMessage(ADMIN_TG_ID,
        `🤝 <b>Новая заявка на партнёрство #${p.id}</b>\n\n👤 ${user.username ? '@'+user.username : user.first_name}\n📢 Канал: ${channel_url}\n👥 Подписчиков: ${subsCheck.count}\n🔗 Пост: ${post_url}\n✅ Пост проверен — содержит ссылку на бота`,
        { parse_mode: 'HTML' }
      )
    } catch {}

    res.json({ ok: true, partnership: p })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// GET /api/partnership/all — all applications (admin)
router.get('/all', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, u.username, u.first_name, u.telegram_id, u.referral_count
       FROM partnerships p JOIN users u ON p.user_id=u.id
       ORDER BY p.created_at DESC`
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/partnership/approve/:id — atomic approve with status check
router.post('/approve/:id', async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows: [p] } = await client.query(
      "SELECT * FROM partnerships WHERE id=$1 AND status='pending' FOR UPDATE", [req.params.id]
    )
    if (!p) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Заявка не найдена или уже обработана' }) }

    await client.query("UPDATE partnerships SET status='approved' WHERE id=$1", [p.id])

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE id=$1', [p.user_id])

    // Get settings
    const channelLink = p.channel_url.startsWith('https://') ? p.channel_url : 'https://t.me/' + p.channel_name
    const { rows: s } = await client.query("SELECT key,value FROM settings WHERE key IN ('task_reward','partnership_task_execs','partnership_enabled')")
    const reward = parseFloat(s.find(r => r.key === 'task_reward')?.value || 0.05)
    const fallbackExecs = parseInt(s.find(r => r.key === 'partnership_task_execs')?.value || 100)
    const mode = s.find(r => r.key === 'partnership_enabled')?.value || '1'

    // Determine max_executions by subscriber count level
    const subsCheck = await checkChannelSubs(p.channel_url).catch(() => ({ ok: false, count: 0 }))
    const subCount = subsCheck.ok ? subsCheck.count : 0
    const lvlSettings = await loadLevelSettings(client)
    const level = getLevel(subCount, lvlSettings)
    const maxExecs = level.maxExecs || fallbackExecs

    // In test mode (3), create task as inactive
    const taskActive = mode !== '3'

    // Get channel photo
    let channelPhoto = null
    try {
      const bot = getBot()
      if (bot) {
        const match = p.channel_url.match(/t\.me\/([^/?]+)/)
        if (match) {
          const chat = await bot.getChat('@' + match[1]).catch(() => null)
          if (chat?.photo?.big_file_id) {
            const fileInfo = await bot.getFile(chat.photo.big_file_id).catch(() => null)
            if (fileInfo?.file_path) {
              channelPhoto = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`
            }
          }
        }
      }
    } catch {}

    const { rows: [task] } = await client.query(
      `INSERT INTO tasks (title, description, reward, link, type, active, price_per_exec, ref_bonus, project_fee, icon, channel_photo, max_executions)
       VALUES ($1,$2,$3,$4,'subscribe',$5,0,0,0,'📢',$6,$7) RETURNING *`,
      [`Подписаться на @${p.channel_name || 'канал'}`, `Подпишись на канал партнёра TonEra и получи награду`, reward, channelLink, taskActive, channelPhoto, maxExecs]
    )

    await client.query('UPDATE partnerships SET task_id=$1 WHERE id=$2', [task.id, p.id])

    await client.query('COMMIT')

    // Notifications (best-effort, after commit)
    try {
      const bot = getBot()
      if (bot) await bot.sendMessage(user.telegram_id,
        `🤝 <b>Заявка на партнёрство одобрена!</b>\n\nВаш канал добавлен в задания TonEra.\n${taskActive ? 'Пользователи будут подписываться на ваш канал и получать награду TON.' : '🔬 Тестовый режим — задание создано, но пока неактивно.'}`,
        { parse_mode: 'HTML' }
      )
    } catch {}

    res.json({ ok: true, task })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// POST /api/partnership/reject/:id — with status check
router.post('/reject/:id', async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [p] } = await client.query(
      "SELECT * FROM partnerships WHERE id=$1 AND status='pending' FOR UPDATE", [req.params.id]
    )
    if (!p) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Заявка не найдена или уже обработана' }) }

    await client.query("UPDATE partnerships SET status='rejected' WHERE id=$1", [p.id])
    await client.query('COMMIT')

    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id=$1', [p.user_id])
    try {
      const bot = getBot()
      if (bot) await bot.sendMessage(user.telegram_id,
        `❌ <b>Заявка на партнёрство отклонена</b>\n\nУбедитесь что пост содержит ссылку на бота и повторите попытку.`,
        { parse_mode: 'HTML' }
      )
    } catch {}
    res.json({ ok: true })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})


// POST /api/partnership/post/:id — publish post in partner's channel
router.post('/post/:id', async (req, res) => {
  try {
    const { text, photo } = req.body
    if (!text?.trim()) return res.status(400).json({ error: 'Текст поста пустой' })

    const { rows: [p] } = await pool.query(
      'SELECT p.*, u.telegram_id FROM partnerships p JOIN users u ON p.user_id=u.id WHERE p.id=$1',
      [req.params.id]
    )
    if (!p) return res.status(404).json({ error: 'Партнёрство не найдено' })
    if (p.status !== 'approved') return res.status(400).json({ error: 'Партнёрство не одобрено' })

    const bot = getBot()
    if (!bot) return res.status(500).json({ error: 'Бот недоступен' })

    const match = p.channel_url.match(/t\.me\/([^/?]+)/)
    if (!match) return res.status(400).json({ error: 'Неверная ссылка на канал' })
    const channelName = '@' + match[1]

    let msg
    if (photo) {
      const base64Data = photo.replace(/^data:image\/\w+;base64,/, '')
      const photoBuffer = Buffer.from(base64Data, 'base64')
      msg = await bot.sendPhoto(channelName, photoBuffer, { caption: text, parse_mode: 'HTML' }, { filename: 'photo.jpg', contentType: 'image/jpeg' })
    } else {
      msg = await bot.sendMessage(channelName, text, { parse_mode: 'HTML' })
    }

    res.json({ ok: true, message_id: msg.message_id })
  } catch (e) {
    res.status(500).json({ error: 'Не удалось опубликовать: ' + e.message })
  }
})

// POST /api/partnership/cancel — пользователь отказывается от сотрудничества
router.post('/cancel', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Пользователь не найден' }) }

    const { rows: [p] } = await client.query(
      "SELECT * FROM partnerships WHERE user_id=$1 AND status IN ('pending','approved') FOR UPDATE", [user.id]
    )
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Активное партнёрство не найдено' }) }

    // Deactivate task if exists
    if (p.task_id) {
      await client.query('UPDATE tasks SET active=false WHERE id=$1', [p.task_id])
    }

    // Deactivate partner promo codes
    await client.query(
      "UPDATE promo_codes SET active=false WHERE partnership_id=$1 OR (channel_name IS NOT NULL AND type='partner' AND channel_name=(SELECT channel_name FROM partnerships WHERE id=$1))",
      [p.id]
    )

    // Archive instead of delete — set status='cancelled' + cancelled_at
    await client.query(
      "UPDATE partnerships SET status='cancelled', cancelled_at=NOW() WHERE id=$1", [p.id]
    )
    await client.query('COMMIT')

    const cooldownEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    // Notify admin
    try {
      const bot = getBot()
      if (bot) await bot.sendMessage(ADMIN_TG_ID,
        `🚫 <b>Партнёр отказался от сотрудничества</b>\n\n👤 ${user.username ? '@'+user.username : user.first_name}\n📢 Канал: ${p.channel_url}\n📝 Задание деактивировано\n⏳ Повторная заявка: ${cooldownEnd.toLocaleDateString('ru')}`,
        { parse_mode: 'HTML' }
      )
    } catch {}

    res.json({ ok: true, cooldown_until: cooldownEnd.toISOString() })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// POST /api/partnership/unsuspend/:id — admin unblocks suspended partner
router.post('/unsuspend/:id', async (req, res) => {
  try {
    const { rows: [p] } = await pool.query(
      "SELECT * FROM partnerships WHERE id=$1 AND status='suspended'", [req.params.id]
    )
    if (!p) return res.status(404).json({ error: 'Партнёрство не найдено или не заблокировано' })

    await pool.query(
      "UPDATE partnerships SET status='approved', suspended_reason=NULL WHERE id=$1", [p.id]
    )

    // Reactivate task
    if (p.task_id) {
      await pool.query('UPDATE tasks SET active=true WHERE id=$1', [p.task_id])
    }

    // Notify partner
    try {
      const { rows: [user] } = await pool.query('SELECT telegram_id FROM users WHERE id=$1', [p.user_id])
      const bot = getBot()
      if (bot && user) {
        bot.sendMessage(user.telegram_id,
          `✅ <b>Партнёрство разблокировано!</b>\n\nВаше партнёрство восстановлено. Задание снова активно.`,
          { parse_mode: 'HTML' }
        ).catch(() => {})
      }
    } catch {}

    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/partnership/:id — atomic delete with task deactivation
router.delete('/:id', async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [p] } = await client.query('SELECT * FROM partnerships WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Не найдено' }) }

    // Deactivate task if exists
    if (p.task_id) {
      await client.query('UPDATE tasks SET active=false WHERE id=$1', [p.task_id])
    }

    await client.query('DELETE FROM partnerships WHERE id=$1', [p.id])
    await client.query('COMMIT')
    res.json({ ok: true })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// POST /api/partnership/check-status/:id — manual check
router.post('/check-status/:id', async (req, res) => {
  try {
    const { rows: [p] } = await pool.query(
      'SELECT p.*, u.telegram_id FROM partnerships p JOIN users u ON p.user_id=u.id WHERE p.id=$1',
      [req.params.id]
    )
    if (!p) return res.status(404).json({ error: 'Не найдено' })

    const bot = getBot()
    const issues = []

    // Check bot as admin
    try {
      const match = p.channel_url.match(/t\.me\/([^/?]+)/)
      if (match) {
        const botInfo = await bot.getMe()
        const member = await bot.getChatMember('@' + match[1], botInfo.id).catch(() => null)
        if (!member || !['administrator','creator'].includes(member.status)) {
          issues.push('❌ Бот не является администратором канала')
        } else {
          issues.push('✅ Бот — администратор канала')
        }

        // Check subscriber count
        const count = await bot.getChatMemberCount('@' + match[1]).catch(() => 0)
        issues.push(`👥 Подписчиков: ${count}`)
      }
    } catch { issues.push('⚠️ Не удалось проверить канал') }

    // Check post
    if (p.post_url) {
      try {
        const postMatch = p.post_url.match(/t\.me\/([^/]+)\/(\d+)/)
        if (postMatch) {
          const msg = await bot.forwardMessage(ADMIN_TG_ID, '@' + postMatch[1], parseInt(postMatch[2])).catch(() => null)
          if (!msg) {
            issues.push('❌ Рекламный пост удалён')
          } else {
            await bot.deleteMessage(ADMIN_TG_ID, msg.message_id).catch(() => {})
            issues.push('✅ Рекламный пост на месте')
          }
        }
      } catch { issues.push('⚠️ Не удалось проверить пост') }
    }

    // Update last check
    await pool.query('UPDATE partnerships SET last_checked_at=NOW() WHERE id=$1', [p.id])

    const ok = issues.filter(i => i.startsWith('❌')).length === 0
    res.json({ ok, issues })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/partnership/templates
router.get('/templates', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM post_templates ORDER BY created_at DESC')
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/partnership/templates
router.post('/templates', async (req, res) => {
  try {
    const { title, text, photo_url } = req.body
    if (!title?.trim() || !text?.trim()) return res.status(400).json({ error: 'Заполните все поля' })
    const { rows: [t] } = await pool.query(
      'INSERT INTO post_templates (title, text, photo_url) VALUES ($1,$2,$3) RETURNING *',
      [title.trim(), text.trim(), photo_url || null]
    )
    res.json({ ok: true, template: t })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/partnership/templates/:id
router.delete('/templates/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM post_templates WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router