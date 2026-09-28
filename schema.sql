-- ==========================================
-- PixelPop Telegram Bot Database Schema (D1)
-- ==========================================

-- 1. Users Table (User profiles, preferences, VIP status, referrals)
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    language TEXT DEFAULT 'si', -- 'si' (Sinhala) or 'en' (English)
    msg_ids TEXT,               -- Current session target message IDs JSON
    ad_started_at INTEGER,      -- Timestamp when ad was opened
    delivered INTEGER DEFAULT 0,-- 1 if current batch delivered
    is_vip INTEGER DEFAULT 0,   -- 1 if user is active VIP
    vip_until INTEGER DEFAULT 0,-- Epoch timestamp when VIP expires
    referred_by TEXT,           -- User ID of the referrer
    referral_count INTEGER DEFAULT 0, -- Count of valid invites
    created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_vip ON users(is_vip, vip_until);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);

-- 2. Batches Table (Secure random tokens mapping to file message IDs)
CREATE TABLE IF NOT EXISTS batches (
    token TEXT PRIMARY KEY,     -- Unique secure token (e.g. b_a7f92b4c)
    title TEXT,                 -- Movie / Series Title (Optional)
    poster_url TEXT,            -- TMDb Poster Image URL (Optional)
    msg_ids TEXT NOT NULL,      -- JSON array of Storage Channel message IDs
    created_by TEXT,            -- Admin user ID
    created_at INTEGER
);

-- 3. Admin Batch Queue (Tracks pending forwarded files per admin)
CREATE TABLE IF NOT EXISTS admin_batch (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id TEXT NOT NULL,
    message_id INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_batch ON admin_batch(admin_id);

-- 4. Deletions Queue (Files scheduled for 6-hour auto-deletion)
CREATE TABLE IF NOT EXISTS deletions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    delete_at INTEGER NOT NULL,
    reminded INTEGER DEFAULT 0  -- 1 if 30-min reminder was sent
);

CREATE INDEX IF NOT EXISTS idx_deletions_delete_at ON deletions(delete_at);
CREATE INDEX IF NOT EXISTS idx_deletions_reminded ON deletions(reminded, delete_at);

-- 5. Payments Table (Telegram Stars & Micro-transactions)
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,         -- 'stars_fast_pass', 'stars_vip_monthly', etc.
    amount INTEGER NOT NULL,    -- Stars count or LKR amount
    currency TEXT NOT NULL,     -- 'XTR' for Telegram Stars, 'LKR', etc.
    telegram_charge_id TEXT,
    status TEXT DEFAULT 'completed',
    created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);

-- 6. VIP Bank Slip Requests (Manual verification for Sri Lankan users)
CREATE TABLE IF NOT EXISTS vip_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    user_name TEXT,
    file_id TEXT NOT NULL,      -- Telegram photo file_id of bank slip
    plan TEXT DEFAULT 'monthly', -- 'weekly', 'monthly', 'lifetime'
    status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_vip_requests_status ON vip_requests(status);

-- 7. Movie & TV Series Requests Table
CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    user_name TEXT,
    query TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'fulfilled', 'rejected'
    created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

