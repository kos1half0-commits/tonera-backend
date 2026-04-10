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
  }, 6 * 60 * 60 * 1000) // 6 hours

  // Also run first check after 2 minutes (give bot time to initialize)
  setTimeout(() => {
    deactivateExpiredPromos().catch(() => {})
    checkPartners().catch(e => console.error('Partnership initial check error:', e.message))
  }, 120000)

  console.log('🤝 Partnership cron started (every 6h)')
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

async function checkPartners() {
  const { rows: partners } = await pool.query(
    `SELECT p.*, u.telegram_id, u.username, u.first_name
     FROM partnerships p
     JOIN users u ON p.user_id = u.id
     WHERE p.status = 'approved'`
  )

  if (partners.length === 0) return

  const bot = getBot()
  if (!bot) return

  let botInfo
  try { botInfo = await bot.getMe() } catch { return }

  for (const p of partners) {
    const issues = []
    let subCount = 0

    try {
      const match = p.channel_url.match(/t\.me\/([^/?]+)/)
      if (!match) continue
      const channelName = '@' + match[1]

      // Check bot is still admin
      try {
        const member = await bot.getChatMember(channelName, botInfo.id).catch(() => null)
        if (!member || !['administrator', 'creator'].includes(member.status)) {
          issues.push('❌ Бот удалён из администраторов')
        }
      } catch {
        issues.push('⚠️ Не удалось проверить канал')
      }

      // Check post still exists
      if (p.post_url) {
        try {
          const postMatch = p.post_url.match(/t\.me\/([^/]+)\/(\d+)/)
          if (postMatch) {
            const msg = await bot.forwardMessage(ADMIN_TG_ID, '@' + postMatch[1], parseInt(postMatch[2])).catch(() => null)
            if (!msg) {
              issues.push('❌ Рекламный пост удалён')
            } else {
              await bot.deleteMessage(ADMIN_TG_ID, msg.message_id).catch(() => {})
            }
          }
        } catch {
          issues.push('⚠️ Не удалось проверить пост')
        }
      }

      // Get subscriber count
      try {
        subCount = await bot.getChatMemberCount(channelName).catch(() => 0)
      } catch {}

    } catch (e) {
      console.error(`Partnership #${p.id} check error:`, e.message)
      continue
    }

    // Update last checked
    await pool.query('UPDATE partnerships SET last_checked_at = NOW() WHERE id = $1', [p.id])

    // If issues found — pause task and notify
    const hasProblems = issues.some(i => i.startsWith('❌'))

    if (hasProblems && p.task_id) {
      // Pause the task
      await pool.query('UPDATE tasks SET active = false WHERE id = $1 AND active = true', [p.task_id])

      const partnerName = p.username ? `@${p.username}` : p.first_name || 'Партнёр'
      const issueText = issues.join('\n')

      // Notify admin
      try {
        bot.sendMessage(ADMIN_TG_ID,
          `🤝 <b>Проблема с партнёром #${p.id}</b>\n\n` +
          `👤 ${partnerName}\n` +
          `📢 ${p.channel_url}\n` +
          `👥 Подписчиков: ${subCount}\n\n` +
          `${issueText}\n\n` +
          `⏸ Задание автоматически приостановлено`,
          { parse_mode: 'HTML' }
        ).catch(() => {})
      } catch {}

      // Notify partner
      try {
        bot.sendMessage(p.telegram_id,
          `🤝 <b>Внимание: проблема с партнёрством</b>\n\n` +
          `${issueText}\n\n` +
          `⏸ Ваше задание приостановлено до устранения проблемы.\n` +
          `Пожалуйста, исправьте проблемы и свяжитесь с поддержкой.`,
          { parse_mode: 'HTML' }
        ).catch(() => {})
      } catch {}

      console.log(`🤝 Partnership #${p.id} — issues found, task paused: ${issues.join(', ')}`)
    } else {
      // Auto-upgrade max_executions by level
      if (p.task_id && subCount > 0) {
        try {
          const { rows: lvlRows } = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'partnership_lvl_%'")
          const lvlSettings = {}
          lvlRows.forEach(r => lvlSettings[r.key] = r.value)

          const LEVELS = [
            { name: 'Bronze',  min: 0,     settingKey: 'partnership_lvl_bronze_execs', defaultExecs: 100 },
            { name: 'Silver',  min: 5000,  settingKey: 'partnership_lvl_silver_execs', defaultExecs: 500 },
            { name: 'Gold',    min: 20000, settingKey: 'partnership_lvl_gold_execs', defaultExecs: 2000 },
            { name: 'Diamond', min: 50000, settingKey: 'partnership_lvl_diamond_execs', defaultExecs: 10000 },
          ]
          let currentLevel = LEVELS[0]
          for (const l of LEVELS) { if (subCount >= l.min) currentLevel = l }
          const levelMaxExecs = parseInt(lvlSettings[currentLevel.settingKey] || currentLevel.defaultExecs)

          // Check current task max_executions
          const { rows: [taskRow] } = await pool.query('SELECT max_executions FROM tasks WHERE id=$1', [p.task_id])
          if (taskRow && parseInt(taskRow.max_executions) < levelMaxExecs) {
            await pool.query('UPDATE tasks SET max_executions=$1 WHERE id=$2', [levelMaxExecs, p.task_id])
            console.log(`🤝 Partnership #${p.id} — UPGRADED to ${currentLevel.name}: max_executions ${taskRow.max_executions} → ${levelMaxExecs}`)

            // Notify partner about upgrade
            try {
              const partnerName = p.username ? `@${p.username}` : p.first_name || 'Партнёр'
              bot.sendMessage(p.telegram_id,
                `🏅 <b>Поздравляем! Ваш уровень партнёрства повышен!</b>\n\n` +
                `${currentLevel.name === 'Silver' ? '🥈' : currentLevel.name === 'Gold' ? '🥇' : '💎'} Новый уровень: <b>${currentLevel.name}</b>\n` +
                `📊 Макс. выполнений задания: <b>${levelMaxExecs}</b>\n\n` +
                `Продолжайте развивать канал для повышения уровня!`,
                { parse_mode: 'HTML' }
              ).catch(() => {})
            } catch {}
          }
        } catch (e) {
          console.error(`Partnership #${p.id} level check error:`, e.message)
        }
      }
      console.log(`🤝 Partnership #${p.id} — OK (${subCount} subs)`)
    }
  }
}
