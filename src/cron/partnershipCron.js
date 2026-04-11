import pool from '../db/index.js'
import { getBot } from '../bot.js'
import { ADMIN_TG_ID } from '../config.js'

export function startPartnershipCron() {
  // Check every 6 hours
  setInterval(async () => {
    try {
      await deactivateExpiredPromos()
      await checkPartners()
    } catch (e) {
      console.error('Partnership cron error:', e.message)
    }
  }, 6 * 60 * 60 * 1000)

  // Auto-post interval check every hour
  setInterval(async () => {
    try {
      const { rows: [row] } = await pool.query("SELECT value FROM settings WHERE key='partnership_autopost_enabled'")
      if (row?.value !== '1') return

      const { rows: [intRow] } = await pool.query("SELECT value FROM settings WHERE key='partnership_autopost_interval_hours'")
      const intervalHours = parseInt(intRow?.value || '0')
      if (intervalHours <= 0) return

      const { rows: [lastRow] } = await pool.query("SELECT value FROM settings WHERE key='partnership_autopost_last'")
      const lastPost = lastRow?.value ? new Date(lastRow.value) : null
      const now = new Date()

      if (!lastPost || (now - lastPost) >= intervalHours * 60 * 60 * 1000) {
        console.log('📢 Auto-posting to partner channels...')
        await autoPostPartners()
        await pool.query("INSERT INTO settings (key,value) VALUES ('partnership_autopost_last', $1) ON CONFLICT (key) DO UPDATE SET value=$1", [now.toISOString()])
      }
    } catch (e) {
      console.error('Auto-post cron error:', e.message)
    }
  }, 60 * 60 * 1000)

  // Initial check after 2 min
  setTimeout(() => {
    deactivateExpiredPromos().catch(() => {})
    checkPartners().catch(e => console.error('Partnership initial check error:', e.message))
  }, 120000)

  console.log('🤝 Partnership cron started (check 6h, autopost hourly check)')
}

// Auto-deactivate expired partner promo codes
async function deactivateExpiredPromos() {
  const { rowCount } = await pool.query(
    `UPDATE promo_codes SET active = false
     WHERE type = 'partner' AND active = true AND expires_at IS NOT NULL AND expires_at < NOW()`
  )
  if (rowCount > 0) {
    console.log(`🎁 Deactivated ${rowCount} expired partner promo codes`)
  }
}

export async function checkPartners() {
  const { rows: partners } = await pool.query(
    `SELECT p.*, u.telegram_id, u.username, u.first_name
     FROM partnerships p
     JOIN users u ON p.user_id = u.id
     WHERE p.status = 'approved'`
  )

  if (partners.length === 0) return { total: 0, ok: 0, blocked: 0, paused: 0 }

  const bot = getBot()
  if (!bot) return { total: partners.length, ok: 0, blocked: 0, paused: 0, error: 'Bot unavailable' }

  let botInfo
  try { botInfo = await bot.getMe() } catch { return { total: partners.length, ok: 0, blocked: 0, paused: 0, error: 'Bot getMe failed' } }

  const { rows: [minSubsRow] } = await pool.query("SELECT value FROM settings WHERE key='partnership_min_subs'")
  const minSubs = parseInt(minSubsRow?.value || 1000)

  const stats = { total: partners.length, ok: 0, blocked: 0, paused: 0 }

  for (const p of partners) {
    const issues = []
    let subCount = 0
    let critical = false

    try {
      const match = p.channel_url.match(/t\.me\/([^/?]+)/)
      if (!match) continue
      const channelName = '@' + match[1]

      try {
        const member = await bot.getChatMember(channelName, botInfo.id).catch(() => null)
        if (!member || !['administrator', 'creator'].includes(member.status)) {
          issues.push('❌ Бот удалён из администраторов канала')
          critical = true
        } else if (!member.can_post_messages && member.status !== 'creator') {
          issues.push('❌ У бота нет права публикации сообщений')
          critical = true
        } else {
          issues.push('✅ Бот — администратор с правами публикации')
        }
      } catch {
        issues.push('⚠️ Не удалось проверить статус бота в канале')
      }

      try {
        subCount = await bot.getChatMemberCount(channelName).catch(() => 0)
        if (subCount < minSubs) {
          issues.push(`❌ Подписчиков: ${subCount} (минимум: ${minSubs})`)
          critical = true
        } else {
          issues.push(`✅ Подписчиков: ${subCount.toLocaleString()}`)
        }
      } catch {
        issues.push('⚠️ Не удалось проверить количество подписчиков')
      }

      if (p.post_url) {
        try {
          const postMatch = p.post_url.match(/t\.me\/([^/]+)\/(\d+)/)
          if (postMatch) {
            const msg = await bot.forwardMessage(ADMIN_TG_ID, '@' + postMatch[1], parseInt(postMatch[2])).catch(() => null)
            if (!msg) {
              issues.push('❌ Рекламный пост удалён из канала')
            } else {
              await bot.deleteMessage(ADMIN_TG_ID, msg.message_id).catch(() => {})
              issues.push('✅ Рекламный пост на месте')
            }
          }
        } catch {
          issues.push('⚠️ Не удалось проверить рекламный пост')
        }
      }
    } catch (e) {
      console.error(`Partnership #${p.id} check error:`, e.message)
      continue
    }

    await pool.query('UPDATE partnerships SET last_checked_at = NOW() WHERE id = $1', [p.id])
    const hasProblems = issues.some(i => i.startsWith('❌'))

    if (hasProblems && p.task_id) {
      await pool.query('UPDATE tasks SET active = false WHERE id = $1 AND active = true', [p.task_id])
      const partnerName = p.username ? `@${p.username}` : p.first_name || 'Партнёр'
      const issueText = issues.join('\n')

      if (critical) {
        stats.blocked++
        await pool.query(
          "UPDATE partnerships SET status = 'suspended', suspended_reason = $1 WHERE id = $2",
          [issues.filter(i => i.startsWith('❌')).join('; '), p.id]
        )
        try {
          bot.sendMessage(ADMIN_TG_ID,
            `🚨 <b>Партнёрство #${p.id} ЗАБЛОКИРОВАНО</b>\n\n👤 ${partnerName}\n📢 ${p.channel_url}\n👥 Подписчиков: ${subCount}\n\n${issueText}\n\n🔴 Партнёрство автоматически заблокировано`,
            { parse_mode: 'HTML' }
          ).catch(() => {})
        } catch {}
        try {
          bot.sendMessage(p.telegram_id,
            `🚨 <b>Партнёрство заблокировано</b>\n\nВаше партнёрство заблокировано из-за нарушения правил:\n\n${issues.filter(i => i.startsWith('❌')).join('\n')}\n\n⏸ Задание деактивировано.\nДля разблокировки устраните проблемы и обратитесь к администратору.`,
            { parse_mode: 'HTML' }
          ).catch(() => {})
        } catch {}
        console.log(`🚨 Partnership #${p.id} — BLOCKED`)
      } else {
        stats.paused++
        try { bot.sendMessage(ADMIN_TG_ID, `🤝 <b>Проблема с партнёром #${p.id}</b>\n\n👤 ${partnerName}\n📢 ${p.channel_url}\n👥 ${subCount}\n\n${issueText}\n\n⏸ Задание приостановлено`, { parse_mode: 'HTML' }).catch(() => {}) } catch {}
        try { bot.sendMessage(p.telegram_id, `🤝 <b>Внимание: проблема с партнёрством</b>\n\n${issueText}\n\n⏸ Ваше задание приостановлено до устранения проблемы.`, { parse_mode: 'HTML' }).catch(() => {}) } catch {}
        console.log(`🤝 Partnership #${p.id} — paused`)
      }
    } else {
      stats.ok++
      if (p.task_id && subCount > 0) {
        try {
          const { rows: lvlRows } = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'partnership_lvl_%'")
          const lvlSettings = {}
          lvlRows.forEach(r => lvlSettings[r.key] = r.value)
          const LEVELS = [
            { name: 'Bronze', min: 0, settingKey: 'partnership_lvl_bronze_execs', defaultExecs: 100 },
            { name: 'Silver', min: 5000, settingKey: 'partnership_lvl_silver_execs', defaultExecs: 500 },
            { name: 'Gold', min: 20000, settingKey: 'partnership_lvl_gold_execs', defaultExecs: 2000 },
            { name: 'Diamond', min: 50000, settingKey: 'partnership_lvl_diamond_execs', defaultExecs: 10000 },
          ]
          let currentLevel = LEVELS[0]
          for (const l of LEVELS) { if (subCount >= l.min) currentLevel = l }
          const levelMaxExecs = parseInt(lvlSettings[currentLevel.settingKey] || currentLevel.defaultExecs)
          const { rows: [taskRow] } = await pool.query('SELECT max_executions FROM tasks WHERE id=$1', [p.task_id])
          if (taskRow && parseInt(taskRow.max_executions) < levelMaxExecs) {
            await pool.query('UPDATE tasks SET max_executions=$1 WHERE id=$2', [levelMaxExecs, p.task_id])
            try { bot.sendMessage(p.telegram_id, `🏅 <b>Уровень повышен!</b>\n\n${currentLevel.name === 'Silver' ? '🥈' : currentLevel.name === 'Gold' ? '🥇' : '💎'} <b>${currentLevel.name}</b>\n📊 Выполнений: <b>${levelMaxExecs}</b>`, { parse_mode: 'HTML' }).catch(() => {}) } catch {}
          }
        } catch (e) {
          console.error(`Partnership #${p.id} level error:`, e.message)
        }
      }
      console.log(`🤝 Partnership #${p.id} — OK (${subCount} subs)`)
    }
  }

  return stats
}

// Auto-post to all partner channels
export async function autoPostPartners() {
  const bot = getBot()
  if (!bot) return { error: 'Бот недоступен' }

  const { rows: partners } = await pool.query(
    `SELECT p.*, u.telegram_id, u.username, u.first_name, u.ref_code
     FROM partnerships p JOIN users u ON p.user_id = u.id
     WHERE p.status = 'approved' AND p.autopost_enabled = true`
  )
  if (partners.length === 0) return { total: 0, success: 0, failed: 0 }

  const { rows: cfgRows } = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'partnership_%' OR key LIKE 'partner_promo_%' OR key = 'bot_username'")
  const cfg = {}
  cfgRows.forEach(r => cfg[r.key] = r.value)
  const defaultTemplate = cfg['partnership_default_post'] || null
  const defaultPhoto = cfg['partnership_default_post_photo'] || null
  const botUsername = cfg['bot_username'] || 'tonera_bot'
  const expiryHours = parseInt(cfg['partner_promo_expiry_hours'] || '24')

  const levelNames = ['bronze', 'silver', 'gold', 'diamond']
  const levelMins = [0, 5000, 20000, 50000]

  let success = 0, failed = 0
  const results = []

  for (const p of partners) {
    const match = p.channel_url.match(/t\.me\/([^/?]+)/)
    if (!match) { failed++; results.push({ id: p.id, channel: p.channel_url, ok: false, error: 'Bad URL' }); continue }
    const channelName = '@' + match[1]

    let postText = p.custom_post || defaultTemplate || null
    if (!postText) { failed++; results.push({ id: p.id, channel: channelName, ok: false, error: 'Нет текста' }); continue }

    // Determine partner level by subscriber count
    let subCount = 0
    try { subCount = await bot.getChatMemberCount(channelName).catch(() => 0) } catch {}
    let lvlName = 'bronze'
    for (let i = 0; i < levelMins.length; i++) {
      if (subCount >= levelMins[i]) lvlName = levelNames[i]
    }

    // Fetch old active promo codes for this channel (to replace in text)
    const { rows: oldPromos } = await pool.query(
      "SELECT code FROM promo_codes WHERE channel_name = $1 AND type = 'partner' AND active = true",
      [channelName]
    )

    // Archive old active promo codes
    await pool.query(
      "UPDATE promo_codes SET active = false WHERE channel_name = $1 AND type = 'partner' AND active = true",
      [channelName]
    )

    // Generate new promo code
    const prefix = (p.username || 'P').toUpperCase().slice(0, 4)
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase()
    const code = `${prefix}-${rand}`
    const reward = parseFloat(cfg[`partner_promo_${lvlName}_reward`] || '0.01')
    const maxUses = parseInt(cfg[`partner_promo_${lvlName}_uses`] || '10')
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000)

    try {
      await pool.query(
        `INSERT INTO promo_codes (code, amount, max_uses, active, partnership_id, expires_at, channel_name, type)
         VALUES (UPPER($1), $2, $3, true, $4, $5, $6, 'partner')`,
        [code, reward, maxUses, p.id, expiresAt, channelName]
      )
    } catch (e) {
      console.error(`Promo code gen error for #${p.id}:`, e.message)
    }

    // Build promo text block for {PROMO} placeholder
    const promoBlock = `\n\n🎁 Промокод: ${code.toUpperCase()}\n💰 Награда: ${reward} TON (${maxUses} активаций)`

    const refLink = p.ref_code ? `t.me/${botUsername}?start=${p.ref_code}` : `t.me/${botUsername}`
    postText = postText
      .replace(/\\n/g, '\n')
      .replace(/\{REF_LINK\}/g, refLink)
      .replace(/\{PROMO\}/g, promoBlock)

    // Replace old hardcoded promo codes in custom post text with new code
    for (const old of oldPromos) {
      if (old.code && postText.includes(old.code)) {
        postText = postText.replace(new RegExp(old.code.replace(/[-]/g, '\\-'), 'gi'), code.toUpperCase())
      }
    }

    try {
      let msg
      // Always try to send with photo
      const logoUrl = (process.env.APP_URL || 'https://tonera.io') + '/logo.png'
      try {
        if (defaultPhoto) {
          const photoData = defaultPhoto.replace(/^data:image\/\w+;base64,/, '')
          const photoBuffer = Buffer.from(photoData, 'base64')
          msg = await bot.sendPhoto(channelName, photoBuffer, { caption: postText, parse_mode: 'HTML' }, { filename: 'photo.jpg', contentType: 'image/jpeg' })
        } else {
          msg = await bot.sendPhoto(channelName, logoUrl, { caption: postText, parse_mode: 'HTML' })
        }
      } catch {
        // Fallback to text only
        msg = await bot.sendMessage(channelName, postText, { parse_mode: 'HTML' })
      }
      success++
      results.push({ id: p.id, channel: channelName, ok: true, message_id: msg.message_id, promo: code.toUpperCase() })
    } catch (e) {
      failed++
      results.push({ id: p.id, channel: channelName, ok: false, error: e.message })
    }
  }

  // Send stats to admin
  try {
    const successList = results.filter(r => r.ok).map(r => `  ✅ ${r.channel} — 🎁 ${r.promo}`).join('\n')
    const failedList = results.filter(r => !r.ok).map(r => `  ❌ ${r.channel}: ${r.error}`).join('\n')
    bot.sendMessage(ADMIN_TG_ID,
      `📢 <b>Авто-постинг завершён</b>\n\n📊 Всего: ${partners.length}\n✅ Успешно: ${success}\n❌ Ошибок: ${failed}\n\n` +
      (successList ? `<b>Успешные:</b>\n${successList}\n\n` : '') +
      (failedList ? `<b>Ошибки:</b>\n${failedList}` : ''),
      { parse_mode: 'HTML' }
    ).catch(() => {})
  } catch {}

  return { total: partners.length, success, failed, results }
}
