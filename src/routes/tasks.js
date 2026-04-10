import { Router } from 'express'
import pool from '../db/index.js'
import { getBot } from '../bot.js'
import { ADMIN_TG_ID } from '../config.js'

const router = Router()

// GET /api/tasks — задания для исполнителя
router.get('/', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows } = await pool.query(
      `SELECT t.*,
         CASE WHEN ut.id IS NOT NULL THEN true ELSE false END as completed
       FROM tasks t
       LEFT JOIN users u ON u.telegram_id = $1
       LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.user_id = u.id
       WHERE t.active = true
         AND (t.max_executions = 0 OR t.executions < t.max_executions)
       ORDER BY t.created_at DESC`,
      [tgId]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/tasks/my-completed-count — кол-во выполненных заданий
router.get('/my-completed-count', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*) as count FROM user_tasks ut
       JOIN users u ON ut.user_id = u.id
       WHERE u.telegram_id = $1`, [tgId]
    )
    res.json({ count: parseInt(r.count) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/tasks/create — создать задание (заказчик)
router.post('/create', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { type, title, link, channel_title, channel_photo, max_executions } = req.body

    const ALLOWED_COUNTS = [50, 100, 200, 500, 1000]
    if (!ALLOWED_COUNTS.includes(Number(max_executions))) {
      return res.status(400).json({ error: 'Invalid max_executions. Choose: 50,100,200,500,1000' })
    }

    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    // Получаем цены из настроек
    const { rows: settings } = await client.query("SELECT key, value FROM settings WHERE key IN ('task_price','task_reward','task_ref_bonus','task_project_fee')")
    const s = {}
    settings.forEach(r => s[r.key] = parseFloat(r.value))

    const pricePerExec = s.task_price    || 0.002
    const reward       = s.task_reward   || 0.001
    const refBonus     = s.task_ref_bonus  || 0.0002
    const projectFee   = s.task_project_fee || 0.0002
    const budget       = pricePerExec * Number(max_executions)

    // Проверяем баланс
    if (parseFloat(user.balance_ton) < budget) {
      return res.status(400).json({
        error: 'Insufficient balance',
        required: budget,
        available: user.balance_ton
      })
    }

    // Списываем бюджет
    await client.query('UPDATE users SET balance_ton = balance_ton - $1 WHERE id = $2', [budget, user.id])

    // Создаём задание
    const { rows: [task] } = await client.query(
      `INSERT INTO tasks
         (creator_id, type, title, link, channel_title, channel_photo, icon,
          max_executions, executions, budget, reward, price_per_exec, ref_bonus, project_fee, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12,$13,false) RETURNING *`,
      [
        user.id, type || 'subscribe', title, link || null,
        channel_title || null, channel_photo || null,
        type === 'bot' ? '🤖' : '✈️',
        Number(max_executions), budget,
        reward, pricePerExec, refBonus, projectFee
      ]
    )

    // Лог транзакции
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1,'task_budget',$2,$3)`,
      [user.id, -budget, `Бюджет задания: ${title}`]
    )

    await client.query('COMMIT')

    // Уведомление админу о новом задании
    try {
      const bot = getBot()
      if (bot) {
        await bot.sendMessage(ADMIN_TG_ID,
          `📋 <b>Новое задание на проверку</b>\n\n` +
          `👤 ${user.username ? '@' + user.username : user.first_name}\n` +
          `📌 ${title}\n` +
          `🔗 ${link || '—'}\n` +
          `🔢 Выполнений: ${max_executions}\n` +
          `💰 Бюджет: ${budget.toFixed(4)} TON`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Одобрить', callback_data: `approve_task:${task.id}` },
                { text: '❌ Отклонить', callback_data: `reject_task:${task.id}` }
              ]]
            }
          }
        )
      }
    } catch (e) { console.error('Notify error:', e.message) }

    res.json({ task })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

// GET /api/tasks/my — мои задания как заказчика
router.get('/my', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows } = await pool.query(
      `SELECT t.* FROM tasks t
       JOIN users u ON t.creator_id = u.id
       WHERE u.telegram_id = $1
       ORDER BY t.created_at DESC`,
      [tgId]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/tasks/:id/complete — выполнить задание
router.post('/:id/complete', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const taskId = parseInt(req.params.id)

    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    const { rows: [task] } = await client.query('SELECT * FROM tasks WHERE id = $1 AND active = true FOR UPDATE', [taskId])
    if (!task) return res.status(404).json({ error: 'Task not found' })

    // Проверка лимита
    if (task.max_executions > 0 && task.executions >= task.max_executions) {
      return res.status(400).json({ error: 'Task limit reached' })
    }

    // Не выполнять своё задание
    if (task.creator_id === user.id) {
      return res.status(400).json({ error: 'Cannot complete your own task' })
    }

    const { rows: [existing] } = await client.query(
      'SELECT id FROM user_tasks WHERE user_id = $1 AND task_id = $2', [user.id, taskId]
    )
    if (existing) return res.status(400).json({ error: 'Already completed' })

    // Проверка подписки
    if (task.type === 'subscribe' && task.link) {
      const bot = getBot()
      if (bot) {
        try {
          const match = task.link.match(/t\.me\/([^/?]+)/)
          if (match) {
            const member = await bot.getChatMember('@' + match[1], tgId)
            if (!['member','administrator','creator'].includes(member.status)) {
              await client.query('ROLLBACK')
              return res.status(400).json({ error: 'Not subscribed', message: 'Подпишись на канал сначала' })
            }
          }
        } catch {}
      }
    }

    const reward    = parseFloat(task.reward)
    const projFee   = parseFloat(task.project_fee)

    // 1. Начислить исполнителю
    await client.query('UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2', [reward, user.id])
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1,'task',$2,$3)`,
      [user.id, reward, task.title]
    )

    // 2. Реферальный бонус исполнителя (берём из настроек)
    if (user.referred_by) {
      const { rows: [refSetting] } = await client.query("SELECT value FROM settings WHERE key = 'task_ref_bonus'")
      const refBonus = parseFloat(refSetting?.value || 0.0002)
      if (refBonus > 0) {
        const { rows: [referrer] } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [user.referred_by])
        if (referrer) {
          await client.query('UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2', [refBonus, referrer.id])
          await client.query(
            `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1,'ref_task',$2,$3)`,
            [referrer.id, refBonus, `Реф. бонус за задание`]
          )
        }
      }
    }

    // 3. Комиссия проекта — на аккаунт админа
    if (projFee > 0) {
      const { rows: [admin] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [ADMIN_TG_ID])
      if (admin) {
        await client.query('UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2', [projFee, admin.id])
        await client.query(
          `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1,'fee',$2,$3)`,
          [admin.id, projFee, `Комиссия: ${task.title}`]
        )
      }
    }

    // 4. Обновить счётчик задания
    await client.query('UPDATE tasks SET executions = executions + 1 WHERE id = $1', [taskId])

    // 5. Деактивировать если лимит достигнут
    if (task.executions + 1 >= task.max_executions) {
      await client.query('UPDATE tasks SET active = false WHERE id = $1', [taskId])
    }

    // 6. Отметить выполнение
    await client.query('INSERT INTO user_tasks (user_id, task_id) VALUES ($1, $2)', [user.id, taskId])

    await client.query('COMMIT')
    res.json({ success: true, reward })
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    console.error('TASK COMPLETE ERROR:', e.message, e.stack)
    res.status(500).json({ error: e.message || 'Server error' })
  } finally {
    client.release()
  }
})

// POST /api/tasks/:id/pause — поставить на паузу
router.post('/:id/pause', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    const { rows: [task] } = await client.query('SELECT * FROM tasks WHERE id=$1 AND creator_id=$2', [req.params.id, user?.id])
    if (!task) return res.status(404).json({ error: 'Task not found' })
    await client.query('UPDATE tasks SET active=false WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
  finally { client.release() }
})

// POST /api/tasks/:id/resume — возобновить
router.post('/:id/resume', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    const { rows: [task] } = await client.query('SELECT * FROM tasks WHERE id=$1 AND creator_id=$2', [req.params.id, user?.id])
    if (!task) return res.status(404).json({ error: 'Task not found' })
    if (task.executions >= task.max_executions) return res.status(400).json({ error: 'Лимит исчерпан. Докупите выполнения.' })
    await client.query('UPDATE tasks SET active=true WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
  finally { client.release() }
})

// POST /api/tasks/:id/buy-more — докупить выполнения
router.post('/:id/buy-more', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { count } = req.body
    const ALLOWED = [50, 100, 200, 500, 1000]
    if (!ALLOWED.includes(Number(count))) return res.status(400).json({ error: 'Invalid count' })

    await client.query('BEGIN')
    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    const { rows: [task] } = await client.query('SELECT * FROM tasks WHERE id=$1 AND creator_id=$2', [req.params.id, user?.id])
    if (!task) return res.status(404).json({ error: 'Task not found' })

    const { rows: [s] } = await client.query("SELECT key,value FROM settings WHERE key='task_price'")
    const pricePerExec = parseFloat(s?.value || 0.002)
    const cost = pricePerExec * count

    if (parseFloat(user.balance_ton) < cost) return res.status(400).json({ error: 'Insufficient balance' })

    await client.query('UPDATE users SET balance_ton=balance_ton-$1 WHERE id=$2', [cost, user.id])
    await client.query('UPDATE tasks SET max_executions=max_executions+$1, budget=budget+$2, active=true WHERE id=$3', [count, cost, task.id])
    await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'task_budget',$2,$3)", [user.id, -cost, `Докупка выполнений: ${task.title}`])

    await client.query('COMMIT')
    res.json({ ok: true, cost })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// GET /api/tasks/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows: [task] } = await pool.query('SELECT * FROM tasks WHERE id=$1', [req.params.id])
    if (!task) return res.status(404).json({ error: 'Task not found' })
    res.json(task)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// PUT /api/tasks/:id
router.put('/:id', async (req, res) => {
  try {
    const { title, reward, active, max_executions, description } = req.body
    const updates = []
    const vals = []
    let i = 1
    if (title !== undefined) { updates.push(`title=$${i++}`); vals.push(title) }
    if (description !== undefined) { updates.push(`description=$${i++}`); vals.push(description) }
    if (reward !== undefined) { updates.push(`reward=$${i++}`); vals.push(reward) }
    if (active !== undefined) { updates.push(`active=$${i++}`); vals.push(active) }
    if (max_executions !== undefined) { updates.push(`max_executions=$${i++}`); vals.push(max_executions) }
    if (!updates.length) return res.json({ ok: true })
    vals.push(req.params.id)
    await pool.query(`UPDATE tasks SET ${updates.join(',')} WHERE id=$${i}`, vals)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM user_tasks WHERE task_id=$1', [req.params.id])
    await pool.query('DELETE FROM tasks WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router