import { Router } from 'express'
import pool from '../db/index.js'
import { ADMIN_TG_ID } from '../config.js'

const router = Router()

// GET /api/news — все новости
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM news ORDER BY created_at DESC LIMIT 20')
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/news — создать новость (только админ)
router.post('/', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    if (String(tgId) !== String(ADMIN_TG_ID)) return res.status(403).json({ error: 'Forbidden' })
    const { title, body } = req.body
    if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: 'Заполните все поля' })
    const { rows: [news] } = await pool.query(
      'INSERT INTO news (title, body) VALUES ($1,$2) RETURNING *',
      [title.trim(), body.trim()]
    )
    res.json({ ok: true, news })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/news/:id — удалить новость (только админ)
router.delete('/:id', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    if (String(tgId) !== String(ADMIN_TG_ID)) return res.status(403).json({ error: 'Forbidden' })
    await pool.query('DELETE FROM news WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
