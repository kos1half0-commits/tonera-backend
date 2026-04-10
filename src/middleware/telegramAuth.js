import crypto from 'crypto'
import pool from '../db/index.js'

export async function telegramAuth(req, res, next) {
  if (process.env.NODE_ENV !== 'production') {
    const initData = req.headers['x-telegram-init-data']
    if (!initData) {
      req.telegramUser = { id: 123456789, username: 'devuser', first_name: 'Dev' }
      return next()
    }
  }

  const initData = req.headers['x-telegram-init-data']
  if (!initData) return res.status(401).json({ error: 'No init data' })

  try {
    const params = new URLSearchParams(initData)
    const hash = params.get('hash')
    params.delete('hash')

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest()
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

    if (expectedHash !== hash) return res.status(401).json({ error: 'Invalid hash' })

    // Проверяем срок действия initData (24 часа — Mini App переиспользует initData всю сессию)
    const authDate = parseInt(params.get('auth_date'))
    if (authDate && (Date.now() / 1000 - authDate) > 86400) {
      return res.status(401).json({ error: 'Auth data expired' })
    }

    const userParam = params.get('user')
    if (userParam) {
      req.telegramUser = JSON.parse(userParam)

      // Проверяем блокировку
      const { rows: [user] } = await pool.query(
        'SELECT is_blocked FROM users WHERE telegram_id=$1', [req.telegramUser.id]
      )
      if (user?.is_blocked) {
        return res.status(403).json({ error: 'User is blocked' })
      }
    }

    next()
  } catch (e) {
    res.status(401).json({ error: 'Auth failed' })
  }
}
