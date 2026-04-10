import cron from 'node-cron'
import pool from '../db/index.js'

export function startCronJobs() {
  // Каждый час фиксируем накопленный доход в БД
  cron.schedule('0 * * * *', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: stakes } = await client.query(
        `SELECT * FROM stakes WHERE status='active' FOR UPDATE`
      )
      const DAILY_RATE = 0.01
      const msPerDay = 1000 * 60 * 60 * 24
      let updated = 0
      for (const stake of stakes) {
        const elapsedMs = Date.now() - new Date(stake.started_at).getTime()
        const newEarned = parseFloat(stake.earned || 0) + parseFloat(stake.amount) * DAILY_RATE / msPerDay * elapsedMs
        await client.query(
          'UPDATE stakes SET earned=$1, started_at=NOW() WHERE id=$2',
          [newEarned, stake.id]
        )
        updated++
      }
      await client.query('COMMIT')
      console.log(`✅ Staking rewards updated for ${updated} stakes`)
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      console.error('Cron error:', e)
    } finally {
      client.release()
    }
  })

  console.log('⏰ Cron jobs started')
}

// Проверка партнёрств 2 раза в день (в 9:00 и 21:00)
import { getBot } from '../bot.js'
import { ADMIN_TG_ID } from '../config.js'

export function startPartnershipChecks() {
  const check = async () => {
    try {
      const bot = getBot()
      if (!bot) return

      const { rows: partners } = await pool.query(
        "SELECT p.*, u.telegram_id FROM partnerships p JOIN users u ON p.user_id=u.id WHERE p.status='approved'"
      )

      for (const p of partners) {
        const issues = []

        // Проверяем бот как админ канала
        try {
          const match = p.channel_url.match(/t\.me\/([^/?]+)/)
          if (match) {
            const botInfo = await bot.getMe()
            const member = await bot.getChatMember('@' + match[1], botInfo.id).catch(() => null)
            if (!member || !['administrator','creator'].includes(member.status)) {
              issues.push(`❌ Бот удалён из администраторов канала`)
            }
          }
        } catch { issues.push(`⚠️ Не удалось проверить канал`) }

        // Проверяем пост
        if (p.post_url) {
          try {
            const postMatch = p.post_url.match(/t\.me\/([^/]+)\/(\d+)/)
            if (postMatch) {
              const msg = await bot.forwardMessage(ADMIN_TG_ID, '@' + postMatch[1], parseInt(postMatch[2])).catch(() => null)
              if (!msg) {
                issues.push(`❌ Рекламный пост удалён`)
              } else {
                // Удаляем пересланное сообщение
                await bot.deleteMessage(ADMIN_TG_ID, msg.message_id).catch(() => {})
              }
            }
          } catch { issues.push(`⚠️ Не удалось проверить пост`) }
        }

        if (issues.length > 0) {
          const user = p.telegram_id
          const channelName = p.channel_url
          await bot.sendMessage(ADMIN_TG_ID,
            `⚠️ <b>Нарушение партнёрства</b>\n\n📢 Канал: ${channelName}\n👤 ID: ${user}\n\n${issues.join('\n')}`,
            { parse_mode: 'HTML' }
          )
        }
      }
    } catch (e) {
      console.error('Partnership check error:', e.message)
    }
  }

  // Запускаем по расписанию из настроек
  const scheduleNext = async () => {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key='partnership_check_hours'")
    const hoursStr = rows[0]?.value || '9,21'
    const hours = hoursStr.split(',').map(h => parseInt(h.trim())).filter(h => !isNaN(h)).sort((a,b)=>a-b)
    const now = new Date()
    const currentH = now.getHours() * 60 + now.getMinutes()
    let next = new Date()
    const nextH = hours.find(h => h * 60 > currentH)
    if (nextH !== undefined) {
      next.setHours(nextH, 0, 0, 0)
    } else {
      next.setDate(next.getDate() + 1)
      next.setHours(hours[0] || 9, 0, 0, 0)
    }
    const delay = next.getTime() - Date.now()
    setTimeout(async () => { await check(); scheduleNext() }, delay)
    console.log(`⏰ Следующая проверка партнёрств: ${next.toLocaleTimeString('ru')} (часы: ${hoursStr})`)
  }

  scheduleNext()
  console.log('🤝 Partnership checks scheduled')
}
