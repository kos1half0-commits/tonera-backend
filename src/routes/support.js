import { Router } from 'express'
import pool from '../db/index.js'
import { ADMIN_TG_ID } from '../config.js'
import { getBot } from '../bot.js'

const router = Router()

// GET /api/support/my — мои тикеты
router.get('/my', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query('SELECT id FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.json([])
    const { rows } = await pool.query(
      `SELECT t.*,
        (SELECT json_agg(r ORDER BY r.created_at) FROM support_replies r WHERE r.ticket_id=t.id) as replies
       FROM support_tickets t WHERE t.user_id=$1 ORDER BY t.created_at DESC LIMIT 20`,
      [user.id]
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/support/send — отправить сообщение
router.post('/send', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { message, ticket_id } = req.body
    if (!message?.trim()) return res.status(400).json({ error: 'Пустое сообщение' })

    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    let ticketId = ticket_id
    if (!ticketId) {
      // Создаём новый тикет
      const { rows: [ticket] } = await pool.query(
        'INSERT INTO support_tickets (user_id, message) VALUES ($1,$2) RETURNING id',
        [user.id, message.trim()]
      )
      ticketId = ticket.id
    } else {
      // Добавляем реплай к существующему тикету
      await pool.query(
        'INSERT INTO support_replies (ticket_id, from_admin, message) VALUES ($1,false,$2)',
        [ticketId, message.trim()]
      )
      await pool.query("UPDATE support_tickets SET status='open' WHERE id=$1", [ticketId])
    }

    // Уведомление админу
    try {
      const bot = getBot()
      if (bot) await bot.sendMessage(ADMIN_TG_ID,
        `💬 <b>Обращение в поддержку</b>\n\n👤 ${user.username ? '@'+user.username : user.first_name} (ID: ${tgId})\n📝 ${message.trim()}\n\n🔖 Тикет #${ticketId}`,
        { parse_mode: 'HTML' }
      )
    } catch {}

    res.json({ ok: true, ticket_id: ticketId })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Admin routes
// GET /api/support/admin/all
router.get('/all', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, u.username, u.first_name, u.telegram_id,
        (SELECT json_agg(r ORDER BY r.created_at) FROM support_replies r WHERE r.ticket_id=t.id) as replies
       FROM support_tickets t JOIN users u ON t.user_id=u.id
       ORDER BY t.created_at DESC LIMIT 50`
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/support/admin/reply
router.post('/admin/reply', async (req, res) => {
  try {
    const { ticket_id, message } = req.body
    if (!ticket_id || !message?.trim()) return res.status(400).json({ error: 'Invalid' })

    await pool.query(
      'INSERT INTO support_replies (ticket_id, from_admin, message) VALUES ($1,true,$2)',
      [ticket_id, message.trim()]
    )
    await pool.query("UPDATE support_tickets SET status='answered' WHERE id=$1", [ticket_id])

    // Уведомление юзеру
    try {
      const { rows: [ticket] } = await pool.query(
        'SELECT u.telegram_id FROM support_tickets t JOIN users u ON t.user_id=u.id WHERE t.id=$1',
        [ticket_id]
      )
      const bot = getBot()
      if (bot && ticket) await bot.sendMessage(ticket.telegram_id,
        `💬 <b>Ответ поддержки</b>\n\n${message.trim()}\n\n<i>Откройте приложение чтобы продолжить диалог</i>`,
        { parse_mode: 'HTML' }
      )
    } catch {}

    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/support/admin/close
router.post('/admin/close', async (req, res) => {
  try {
    await pool.query("UPDATE support_tickets SET status='closed' WHERE id=$1", [req.body.ticket_id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router