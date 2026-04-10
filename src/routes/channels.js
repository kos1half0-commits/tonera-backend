import { Router } from 'express'
import { getBot } from '../bot.js'

const router = Router()

// GET /api/channels/info?link=https://t.me/username
// Автозагрузка данных канала/бота
router.get('/info', async (req, res) => {
  try {
    const { link } = req.query
    if (!link) return res.status(400).json({ error: 'link required' })

    const bot = getBot()
    if (!bot) return res.status(500).json({ error: 'Bot not initialized' })

    // Извлекаем username из ссылки
    const match = link.match(/t\.me\/([^/?]+)/)
    if (!match) return res.status(400).json({ error: 'Invalid telegram link' })

    const username = match[1]

    try {
      const chat = await bot.getChat('@' + username)
      const title = chat.title || chat.first_name || username
      const photo = `https://t.me/i/userpic/320/${username}.jpg`
      res.json({
        id: chat.id,
        title,
        description: chat.description || chat.bio || '',
        username: chat.username || username,
        type: chat.type,
        photo,
      })
    } catch (e) {
      // Если не можем получить инфу — возвращаем базовую с фото
      const cleanUsername = username.replace('@', '')
      res.json({
        title: cleanUsername,
        description: '',
        username: cleanUsername,
        photo: `https://t.me/i/userpic/320/${cleanUsername}.jpg`,
      })
    }
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/channels/check?link=... — проверить что бот является админом канала
router.get('/check', async (req, res) => {
  try {
    const { link } = req.query
    if (!link) return res.status(400).json({ error: 'link required' })

    const bot = getBot()
    if (!bot) return res.status(500).json({ error: 'Bot not initialized' })

    const match = link.match(/t\.me\/([^/?]+)/)
    if (!match) return res.status(400).json({ error: 'Invalid telegram link' })

    const username = '@' + match[1]

    try {
      const botInfo = await bot.getMe()
      const member = await bot.getChatMember(username, botInfo.id)
      const isAdmin = ['administrator', 'creator'].includes(member.status)
      res.json({ ok: isAdmin, status: member.status, bot: botInfo.username })
    } catch (e) {
      res.json({ ok: false, status: 'not_member', error: e.message })
    }
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router