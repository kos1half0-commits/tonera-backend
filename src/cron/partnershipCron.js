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

  // Load min subs setting
  const { rows: [minSubsRow] } = await pool.query("SELECT value FROM settings WHERE key='partnership_min_subs'")
  const minSubs = parseInt(minSubsRow?.value || 1000)

  for (const p of partners) {
    const issues = []
    let subCount = 0
    let critical = false // critical = auto-block partnership

    try {
      const match = p.channel_url.match(/t\.me\/([^/?]+)/)
      if (!match) continue
      const channelName = '@' + match[1]

      // 1. Check bot is still admin with posting rights
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

      // 2. Check subscriber count vs minimum
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

      // 3. Check promo post still exists
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

    // Update last checked
    await pool.query('UPDATE partnerships SET last_checked_at = NOW() WHERE id = $1', [p.id])

    const hasProblems = issues.some(i => i.startsWith('❌'))

    if (hasProblems && p.task_id) {
      // Pause the task
      await pool.query('UPDATE tasks SET active = false WHERE id = $1 AND active = true', [p.task_id])

      const partnerName = p.username ? `@${p.username}` : p.first_name || 'Партнёр'
      const issueText = issues.join('\n')

      if (critical) {
        // Critical violation — block partnership
        await pool.query(
          "UPDATE partnerships SET status = 'suspended', suspended_reason = $1 WHERE id = $2",
          [issues.filter(i => i.startsWith('❌')).join('; '), p.id]
        )

        // Notify admin
        try {
          bot.sendMessage(ADMIN_TG_ID,
            `🚨 <b>Партнёрство #${p.id} ЗАБЛОКИРОВАНО</b>\n\n` +
            `👤 ${partnerName}\n` +
            `📢 ${p.channel_url}\n` +
            `👥 Подписчиков: ${subCount}\n\n` +
            `${issueText}\n\n` +
            `🔴 Партнёрство автоматически заблокировано`,
            { parse_mode: 'HTML' }
          ).catch(() => {})
        } catch {}

        // Notify partner
        try {
          bot.sendMessage(p.telegram_id,
            `🚨 <b>Партнёрство заблокировано</b>\n\n` +
            `Ваше партнёрство заблокировано из-за нарушения правил:\n\n` +
            `${issues.filter(i => i.startsWith('❌')).join('\n')}\n\n` +
            `⏸ Задание деактивировано.\n` +
            `Для разблокировки устраните проблемы и обратитесь к администратору.`,
            { parse_mode: 'HTML' }
          ).catch(() => {})
        } catch {}

        console.log(`🚨 Partnership #${p.id} — BLOCKED: ${issues.filter(i => i.startsWith('❌')).join(', ')}`)
      } else {
        // Non-critical — just pause task
        try {
          bot.sendMessage(ADMIN_TG_ID,
            `🤝 <b>Проблема с партнёром #${p.id}</b>\n\n` +
            `👤 ${partnerName}\n` +
            `📢 ${p.channel_url}\n` +
            `👥 Подписчиков: ${subCount}\n\n` +
            `${issueText}\n\n` +
            `⏸ Задание приостановлено`,
            { parse_mode: 'HTML' }
          ).catch(() => {})
        } catch {}

        try {
          bot.sendMessage(p.telegram_id,
            `🤝 <b>Внимание: проблема с партнёрством</b>\n\n` +
            `${issueText}\n\n` +
            `⏸ Ваше задание приостановлено до устранения проблемы.`,
            { parse_mode: 'HTML' }
          ).catch(() => {})
        } catch {}

        console.log(`🤝 Partnership #${p.id} — issues found, task paused`)
      }
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

          const { rows: [taskRow] } = await pool.query('SELECT max_executions FROM tasks WHERE id=$1', [p.task_id])
          if (taskRow && parseInt(taskRow.max_executions) < levelMaxExecs) {
            await pool.query('UPDATE tasks SET max_executions=$1 WHERE id=$2', [levelMaxExecs, p.task_id])
            console.log(`🤝 Partnership #${p.id} — UPGRADED to ${currentLevel.name}: ${taskRow.max_executions} → ${levelMaxExecs}`)

            try {
              bot.sendMessage(p.telegram_id,
                `🏅 <b>Уровень партнёрства повышен!</b>\n\n` +
                `${currentLevel.name === 'Silver' ? '🥈' : currentLevel.name === 'Gold' ? '🥇' : '💎'} Уровень: <b>${currentLevel.name}</b>\n` +
                `📊 Выполнений в месяц: <b>${levelMaxExecs}</b>`,
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
