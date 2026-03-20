const pool = require('./db');

async function runMigrations() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        google_id TEXT UNIQUE,
        display_name TEXT NOT NULL,
        email TEXT UNIQUE,
        avatar TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user1_id UUID REFERENCES users(id),
        user2_id UUID REFERENCES users(id),
        region TEXT,
        interests TEXT[],
        started_at TIMESTAMPTZ DEFAULT now(),
        ended_at TIMESTAMPTZ,
        duration_seconds INT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID REFERENCES sessions(id),
        sender_id UUID REFERENCES users(id),
        content TEXT NOT NULL,
        sent_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS friends (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user1_id UUID REFERENCES users(id),
        user2_id UUID REFERENCES users(id),
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE(user1_id, user2_id)
      );

      CREATE TABLE IF NOT EXISTS reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reporter_ip TEXT,
        session_id UUID,
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS online_status (
        user_id UUID PRIMARY KEY REFERENCES users(id),
        is_online BOOLEAN DEFAULT false,
        last_seen TIMESTAMPTZ DEFAULT now()
      );
    `);
    console.log('[DB] Migrations complete');
  } catch (err) {
    console.error('[DB] Migration error:', err.message);
  }
}

module.exports = runMigrations;
