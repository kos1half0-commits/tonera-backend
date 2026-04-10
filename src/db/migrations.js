import pool from '../db/index.js'

export async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id              SERIAL PRIMARY KEY,
      telegram_id     BIGINT UNIQUE NOT NULL,
      username        TEXT,
      first_name      TEXT,
      last_name       TEXT,
      balance_ton     NUMERIC(18, 8) DEFAULT 0,
      ref_code        TEXT UNIQUE,
      referred_by     BIGINT REFERENCES users(telegram_id),
      referral_count  INT DEFAULT 0,
      ton_address     TEXT,
      is_blocked      BOOLEAN DEFAULT false,
      pending_ref     TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS stakes (
      id          SERIAL PRIMARY KEY,
      user_id     INT REFERENCES users(id),
      pool_id     INT DEFAULT NULL,
      amount      NUMERIC(18, 8) NOT NULL,
      earned      NUMERIC(18, 8) DEFAULT 0,
      started_at  TIMESTAMPTZ DEFAULT NOW(),
      ends_at     TIMESTAMPTZ,
      status      TEXT DEFAULT 'active',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id              SERIAL PRIMARY KEY,
      creator_id      INT REFERENCES users(id) DEFAULT NULL,
      type            TEXT NOT NULL DEFAULT 'subscribe',
      title           TEXT NOT NULL,
      description     TEXT,
      reward          NUMERIC(18, 8) NOT NULL DEFAULT 0.001,
      price_per_exec  NUMERIC(18, 8) NOT NULL DEFAULT 0.002,
      ref_bonus       NUMERIC(18, 8) NOT NULL DEFAULT 0.0002,
      project_fee     NUMERIC(18, 8) NOT NULL DEFAULT 0.0002,
      icon            TEXT DEFAULT '✈️',
      link            TEXT,
      channel_title   TEXT,
      channel_photo   TEXT,
      max_executions  INT DEFAULT 100,
      executions      INT DEFAULT 0,
      budget          NUMERIC(18, 8) DEFAULT 0,
      active          BOOLEAN DEFAULT true,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_tasks (
      id           SERIAL PRIMARY KEY,
      user_id      INT REFERENCES users(id),
      task_id      INT REFERENCES tasks(id),
      completed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, task_id)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id          SERIAL PRIMARY KEY,
      user_id     INT REFERENCES users(id),
      type        TEXT NOT NULL,
      amount      NUMERIC(18, 8) NOT NULL,
      label       TEXT,
      status      TEXT DEFAULT 'completed',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS referrals (
      id           SERIAL PRIMARY KEY,
      referrer_id  INT REFERENCES users(id),
      referred_id  INT REFERENCES users(id),
      bonus_paid   BOOLEAN DEFAULT false,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // ALTER TABLE — добавляем колонки если ещё нет
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked  BOOLEAN DEFAULT false`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_ref TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_balance NUMERIC(18,8) DEFAULT 0`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_bonus_claimed BOOLEAN DEFAULT false`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS miner_balance NUMERIC(18,8) DEFAULT 0`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS creator_id     INT REFERENCES users(id) DEFAULT NULL`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS price_per_exec NUMERIC(18,8) DEFAULT 0.002`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ref_bonus      NUMERIC(18,8) DEFAULT 0.0002`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_fee    NUMERIC(18,8) DEFAULT 0.0002`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS max_executions INT DEFAULT 100`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS executions     INT DEFAULT 0`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget         NUMERIC(18,8) DEFAULT 0`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS channel_title  TEXT`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS channel_photo  TEXT`)

  // Колонка status для transactions (нужна для trading_bet open/closed)
  await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed'`)

  // Настройки
  await pool.query(`
    INSERT INTO settings (key, value) VALUES
      ('ref_register_bonus',  '0.001'),
      ('ref_deposit_percent', '5'),
      ('task_reward',         '0.001'),
      ('task_price',          '0.002'),
      ('task_ref_bonus',      '0.0002'),
      ('task_project_fee',    '0.0002'),
      ('project_wallet',      ''),
      ('min_deposit_ton',     '0.5'),
      ('withdraw_fee',        '0'),
      ('min_withdraw_ton',   '1'),
      ('maintenance',         '0'),
      ('launch_date',         '2025-03-01'),
      ('spin_price',          '0.1'),
      ('spin_enabled',        '1'),
      ('spin_jackpot',        '0'),
      ('spin_bank',           '0'),
      ('spin_jackpot_fee',    '10'),
      ('spin_pool',           '0'),
      ('spin_profit_fee',    '20'),
      ('trading_enabled',    '1'),
      ('slots_enabled',     '1'),
      ('slots_min_bet',     '0.01'),
      ('slots_bank',        '0'),
      ('slots_win_chance',  '45'),
      ('trading_multiplier', '90'),
      ('trading_bank',        '0'),
      ('trading_commission',  '5'),
      ('trading_profit_fee', '10'),
      ('spin_sectors',        '[{"label":"😢 Ничего","type":"nothing","value":0,"chance":35},{"label":"💎 0.01 TON","type":"ton","value":0.01,"chance":25},{"label":"💎 0.05 TON","type":"ton","value":0.05,"chance":20},{"label":"💎 0.1 TON","type":"ton","value":0.1,"chance":12},{"label":"💎 0.5 TON","type":"ton","value":0.5,"chance":5},{"label":"💎 1 TON","type":"ton","value":1,"chance":2},{"label":"🎰 ДЖЕКПОТ","type":"jackpot","value":0,"chance":1}]'),
      ('min_collect',         '0.001'),
      ('min_deposit',          '0.01'),
      ('min_withdraw',         '0.01'),
      ('min_reinvest',         '0.001'),
      ('staking_withdraw_fee', '0')
    ON CONFLICT (key) DO NOTHING;
  `)

  // Sync PROJECT_WALLET from env to DB if set
  if (process.env.PROJECT_WALLET) {
    await pool.query(
      "INSERT INTO settings (key,value) VALUES ('project_wallet',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value WHERE settings.value=''",
      [process.env.PROJECT_WALLET]
    )
  }

  // --- Дополнительные таблицы ---

  // Support tickets
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      message TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_replies (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER REFERENCES support_tickets(id),
      from_admin BOOLEAN DEFAULT FALSE,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // News
  await pool.query(`
    CREATE TABLE IF NOT EXISTS news (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // Partnerships (единая таблица, без дубликата)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partnerships (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      channel_url VARCHAR(300) NOT NULL,
      channel_name VARCHAR(200),
      post_url VARCHAR(300),
      status VARCHAR(20) DEFAULT 'pending',
      task_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  // Добавляем колонки если таблица уже существовала без них
  await pool.query(`ALTER TABLE partnerships ADD COLUMN IF NOT EXISTS post_url VARCHAR(300)`)
  await pool.query(`ALTER TABLE partnerships ADD COLUMN IF NOT EXISTS task_id INTEGER`)
  await pool.query(`ALTER TABLE partnerships ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE partnerships ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`)

  await pool.query("INSERT INTO settings (key,value) VALUES ('partnership_ref_percent','30') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partnership_enabled','1') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partnership_min_subs','1000') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partnership_task_execs','100') ON CONFLICT (key) DO NOTHING")

  // Post templates
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_templates (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      text TEXT NOT NULL,
      photo_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  await pool.query("INSERT INTO settings (key,value) VALUES ('partnership_check_hours','9,21') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partnership_lvl_bronze_execs','100') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partnership_lvl_silver_execs','500') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partnership_lvl_gold_execs','2000') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partnership_lvl_diamond_execs','10000') ON CONFLICT (key) DO NOTHING")

  // Promo codes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      id SERIAL PRIMARY KEY,
      code VARCHAR(50) UNIQUE NOT NULL,
      amount NUMERIC(18,8) NOT NULL,
      max_uses INTEGER DEFAULT 1,
      uses INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  await pool.query(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS partnership_id INTEGER`)
  await pool.query(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS channel_name VARCHAR(100)`)
  await pool.query(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'manual'`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_uses (
      id SERIAL PRIMARY KEY,
      promo_id INTEGER REFERENCES promo_codes(id),
      user_id INTEGER REFERENCES users(id),
      used_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(promo_id, user_id)
    )
  `)

  // Partner promo settings per level
  await pool.query("INSERT INTO settings (key,value) VALUES ('partner_promo_bronze_reward','0.01') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partner_promo_bronze_uses','10') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partner_promo_silver_reward','0.02') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partner_promo_silver_uses','25') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partner_promo_gold_reward','0.05') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partner_promo_gold_uses','50') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partner_promo_diamond_reward','0.1') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partner_promo_diamond_uses','100') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('partner_promo_expiry_hours','24') ON CONFLICT (key) DO NOTHING")

  // Task templates
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_templates (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      link TEXT,
      channel_title TEXT,
      channel_photo TEXT,
      type VARCHAR(20) DEFAULT 'subscribe',
      icon VARCHAR(10) DEFAULT '✈️',
      reward NUMERIC(18,8),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // Admins
  await pool.query(`CREATE TABLE IF NOT EXISTS admins (id SERIAL PRIMARY KEY, telegram_id BIGINT UNIQUE NOT NULL, username VARCHAR(100), added_at TIMESTAMP DEFAULT NOW())`)

  // Miners
  await pool.query(`
    CREATE TABLE IF NOT EXISTS miners (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) UNIQUE NOT NULL,
      level INTEGER DEFAULT 1,
      speed NUMERIC(18,8) DEFAULT 0.001,
      balance NUMERIC(18,8) DEFAULT 0,
      active BOOLEAN DEFAULT true,
      last_collect TIMESTAMPTZ DEFAULT NOW(),
      last_electricity TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_enabled','0') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_price','1') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_speed_base','0.001') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_electricity_cost','0.01') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_electricity_hours','24') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_upgrade_multiplier','1.5') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_upgrade_price_multiplier','2') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_upgrade_price_1','0.5') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_upgrade_price_2','1') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_upgrade_price_3','2') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_upgrade_price_4','4') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_upgrade_price_5','8') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_upgrade_price','0.5') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_electricity_level_percent','10') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_electricity_percent','10') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_min_collect','0.01') ON CONFLICT (key) DO NOTHING")

  // === CT Pool-style Mining Contracts ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS miner_contracts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      plan_id VARCHAR(20) NOT NULL,
      hashrate NUMERIC(18,4) NOT NULL,
      price_paid NUMERIC(18,8) NOT NULL,
      earned NUMERIC(18,8) DEFAULT 0,
      duration_days INTEGER NOT NULL,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) DEFAULT 'active',
      last_accrual TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS miner_withdrawals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      amount NUMERIC(18,8) NOT NULL,
      wallet_address TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      admin_note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // CT Pool plan settings (configurable from admin)
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_starter_price','0.5') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_starter_hashrate','100') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_starter_days','7') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_advanced_price','2') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_advanced_hashrate','500') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_advanced_days','30') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_pro_price','5') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_pro_hashrate','1500') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_pro_days','60') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_elite_price','15') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_elite_hashrate','5000') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_elite_days','90') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_trial_enabled','1') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_trial_hashrate','10') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_trial_days','1') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_free_enabled','1') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_free_hashrate','5') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_plan_free_days','30') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_rate_per_gh','0.0000001') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_min_withdraw','0.01') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_wallet','') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_total_withdrawn','0') ON CONFLICT (key) DO NOTHING")

  // Migrate old miners to contracts (one-time)
  try {
    const { rows: oldMiners } = await pool.query(`SELECT * FROM miners WHERE NOT EXISTS (SELECT 1 FROM miner_contracts WHERE miner_contracts.user_id = miners.user_id)`)
    for (const m of oldMiners) {
      const hashrate = parseFloat(m.speed) * 10000 // convert speed to GH/s equivalent
      const now = new Date()
      const expires = new Date(now.getTime() + 30 * 86400000) // give them 30 days
      await pool.query(
        `INSERT INTO miner_contracts (user_id, plan_id, hashrate, price_paid, earned, duration_days, started_at, expires_at, status, last_accrual)
         VALUES ($1, 'legacy', $2, 0, $3, 30, $4, $5, 'active', $4)`,
        [m.user_id, hashrate, parseFloat(m.balance || 0), now, expires]
      )
    }
    if (oldMiners.length > 0) console.log(`⛏ Migrated ${oldMiners.length} old miners to contracts`)
  } catch (e) { console.log('Miner migration note:', e.message) }

  // Ads
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200),
      text TEXT,
      image_url TEXT,
      link TEXT,
      pages TEXT DEFAULT 'home,tasks,games,staking,miner,wallet',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  await pool.query(`ALTER TABLE ads ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'manual'`)
  await pool.query(`ALTER TABLE ads ADD COLUMN IF NOT EXISTS partnership_id INTEGER`)
  await pool.query(`ALTER TABLE ads ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE ads ADD COLUMN IF NOT EXISTS user_id INTEGER`)
  await pool.query(`ALTER TABLE ads ADD COLUMN IF NOT EXISTS clicks INTEGER DEFAULT 0`)
  await pool.query(`ALTER TABLE ads ADD COLUMN IF NOT EXISTS views INTEGER DEFAULT 0`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ad_clicks (
      id SERIAL PRIMARY KEY,
      ad_id INTEGER REFERENCES ads(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ad_clicks_ad ON ad_clicks (ad_id)')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ad_orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      title VARCHAR(200) NOT NULL,
      text TEXT,
      image_url TEXT,
      link TEXT,
      pages TEXT,
      budget NUMERIC(18,8) DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  await pool.query("INSERT INTO settings (key,value) VALUES ('cloudinary_cloud_name','') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('cloudinary_upload_preset','') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('ad_price_week','5') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('ad_price_2weeks','9') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('ad_price_month','15') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('ad_banner_interval','4') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('miner_electricity_120','0') ON CONFLICT (key) DO NOTHING")

  // === Adsgram Ads ===
  await pool.query("INSERT INTO settings (key,value) VALUES ('adsgram_block_id','') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('adsgram_reward','0.001') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('adsgram_daily_limit','10') ON CONFLICT (key) DO NOTHING")

  // === Referral Auction ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ref_auctions (
      id SERIAL PRIMARY KEY,
      seller_id INTEGER REFERENCES users(id) NOT NULL,
      referral_id INTEGER REFERENCES referrals(id) NOT NULL,
      referred_user_id INTEGER REFERENCES users(id) NOT NULL,
      start_price NUMERIC(18,8) NOT NULL,
      current_price NUMERIC(18,8) NOT NULL,
      min_step NUMERIC(18,8) NOT NULL DEFAULT 0.05,
      duration_hours INTEGER NOT NULL DEFAULT 24,
      status VARCHAR(20) DEFAULT 'active',
      winner_id INTEGER REFERENCES users(id),
      is_test BOOLEAN DEFAULT true,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      ends_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ref_auction_bids (
      id SERIAL PRIMARY KEY,
      auction_id INTEGER REFERENCES ref_auctions(id) ON DELETE CASCADE,
      bidder_id INTEGER REFERENCES users(id) NOT NULL,
      amount NUMERIC(18,8) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query("INSERT INTO settings (key,value) VALUES ('auction_enabled','0') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('auction_test_mode','1') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('auction_min_price','0.1') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('auction_min_step','0.05') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('auction_commission','10') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('auction_max_duration','24') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('auction_min_tasks','50') ON CONFLICT (key) DO NOTHING")
  await pool.query("INSERT INTO settings (key,value) VALUES ('auction_min_activity_days','7') ON CONFLICT (key) DO NOTHING")

  // Auction indexes
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ref_auctions_status_ends ON ref_auctions (status, ends_at)')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ref_auctions_referral ON ref_auctions (referral_id, status)')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ref_auction_bids_auction ON ref_auction_bids (auction_id, amount DESC)')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ref_auction_bids_bidder ON ref_auction_bids (bidder_id)')

  console.log('✅ Migrations done')
}
