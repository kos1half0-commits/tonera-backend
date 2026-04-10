import cron from 'node-cron'
import pool from '../db/index.js'

export function startMinerAccrual() {
  // Every 10 minutes — accrue mining earnings for active contracts
  cron.schedule('*/10 * * * *', async () => {
    const client = await pool.connect()
    try {
      const { rows: [settings] } = await client.query(
        "SELECT value FROM settings WHERE key='miner_rate_per_gh'"
      )
      const ratePerGh = parseFloat(settings?.value ?? 0.0000001)

      await client.query('BEGIN')

      // Expire contracts that have ended
      await client.query(
        "UPDATE miner_contracts SET status='expired' WHERE status='active' AND expires_at <= NOW()"
      )

      // Accrue earnings for active contracts
      const { rows: contracts } = await client.query(
        `SELECT * FROM miner_contracts WHERE status='active' AND expires_at > NOW() FOR UPDATE`
      )

      const now = new Date()
      let updated = 0
      for (const c of contracts) {
        const hoursSinceAccrual = (now - new Date(c.last_accrual)) / 3600000
        if (hoursSinceAccrual < 0.01) continue // skip if less than ~36 seconds

        const accrued = parseFloat(c.hashrate) * ratePerGh * hoursSinceAccrual
        await client.query(
          'UPDATE miner_contracts SET earned=earned+$1, last_accrual=$2 WHERE id=$3',
          [accrued, now, c.id]
        )
        updated++
      }

      await client.query('COMMIT')
      if (updated > 0) console.log(`⛏ Mining accrual: ${updated} contracts updated`)
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      console.error('Mining accrual error:', e.message)
    } finally {
      client.release()
    }
  })

  console.log('⛏ Mining accrual cron started (every 10 min)')
}
