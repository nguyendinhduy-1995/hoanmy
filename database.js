const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'data', 'crm.db');

// Ensure data directory exists
const fs = require('fs');
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    service TEXT NOT NULL,
    appointment_date TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'arrived', 'no_show')),
    notes TEXT DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
  CREATE INDEX IF NOT EXISTS idx_bookings_service ON bookings(service);
  CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(appointment_date);

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'truc_page', 'telesale')),
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    last_login DATETIME
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    role TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_logs_user ON activity_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_logs_date ON activity_logs(created_at);

  CREATE TABLE IF NOT EXISTS landing_meta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id TEXT NOT NULL UNIQUE,
    og_title TEXT DEFAULT '',
    og_description TEXT DEFAULT '',
    og_image TEXT DEFAULT '',
    og_url TEXT DEFAULT '',
    fb_app_id TEXT DEFAULT '',
    custom_head TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    referrer TEXT DEFAULT '',
    utm_source TEXT DEFAULT '',
    utm_medium TEXT DEFAULT '',
    utm_campaign TEXT DEFAULT '',
    utm_content TEXT DEFAULT '',
    device_type TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_pv_service ON page_views(service_id);
  CREATE INDEX IF NOT EXISTS idx_pv_date ON page_views(created_at);
  CREATE INDEX IF NOT EXISTS idx_pv_utm ON page_views(utm_source, utm_medium, utm_campaign);

  CREATE TABLE IF NOT EXISTS call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    call_number INTEGER NOT NULL,
    call_time DATETIME DEFAULT (datetime('now', 'localtime')),
    notes TEXT DEFAULT '',
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_call_logs_booking ON call_logs(booking_id);
  CREATE INDEX IF NOT EXISTS idx_call_logs_user ON call_logs(user_id);

  CREATE TABLE IF NOT EXISTS daily_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date TEXT NOT NULL,
    user_id INTEGER,
    username TEXT,
    role TEXT NOT NULL,
    contacts_count INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    UNIQUE(report_date, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_reports_date ON daily_reports(report_date);
  CREATE INDEX IF NOT EXISTS idx_reports_role ON daily_reports(role);
`);

// ==================== BRANCHES TABLE ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS revenues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    notes TEXT DEFAULT '',
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_revenues_booking ON revenues(booking_id);
  CREATE INDEX IF NOT EXISTS idx_revenues_date ON revenues(created_at);
`);

// Seed default 5 branches if empty
const branchCount = db.prepare('SELECT COUNT(*) as c FROM branches').get().c;
if (branchCount === 0) {
  const insertBranch = db.prepare('INSERT INTO branches (name) VALUES (?)');
  ['Chi nhánh 1', 'Chi nhánh 2', 'Chi nhánh 3', 'Chi nhánh 4', 'Chi nhánh 5'].forEach(n => insertBranch.run(n));
  console.log('  ✅ Seeded 5 default branches');
}

// ==================== SAFE MIGRATIONS ====================

// Add source column to bookings
try { db.prepare("SELECT source FROM bookings LIMIT 1").get(); }
catch (e) { db.prepare("ALTER TABLE bookings ADD COLUMN source TEXT DEFAULT 'landing'").run(); console.log('  ✅ Added source column'); }

// Add branch_id to bookings
try { db.prepare("SELECT branch_id FROM bookings LIMIT 1").get(); }
catch (e) { db.prepare("ALTER TABLE bookings ADD COLUMN branch_id INTEGER REFERENCES branches(id)").run(); console.log('  ✅ Added branch_id to bookings'); }

// Add assigned_to (telesales user) to bookings
try { db.prepare("SELECT assigned_to FROM bookings LIMIT 1").get(); }
catch (e) { db.prepare("ALTER TABLE bookings ADD COLUMN assigned_to INTEGER REFERENCES users(id)").run(); console.log('  ✅ Added assigned_to to bookings'); }

// Add assigned_by to bookings
try { db.prepare("SELECT assigned_by FROM bookings LIMIT 1").get(); }
catch (e) { db.prepare("ALTER TABLE bookings ADD COLUMN assigned_by INTEGER REFERENCES users(id)").run(); console.log('  ✅ Added assigned_by to bookings'); }

// Add assigned_at to bookings
try { db.prepare("SELECT assigned_at FROM bookings LIMIT 1").get(); }
catch (e) { db.prepare("ALTER TABLE bookings ADD COLUMN assigned_at DATETIME").run(); console.log('  ✅ Added assigned_at to bookings'); }

// Add branch_id to users
try { db.prepare("SELECT branch_id FROM users LIMIT 1").get(); }
catch (e) { db.prepare("ALTER TABLE users ADD COLUMN branch_id INTEGER REFERENCES branches(id)").run(); console.log('  ✅ Added branch_id to users'); }

// ==================== PASSWORD UTILS ====================

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const result = hashPassword(password, salt);
  return result.hash === hash;
}

// ==================== CREATE DEFAULT ADMIN ====================

const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
  const { hash, salt } = hashPassword('admin123');
  db.prepare(`
        INSERT INTO users (username, password_hash, salt, display_name, role)
        VALUES (?, ?, ?, ?, ?)
    `).run('admin', hash, salt, 'Administrator', 'admin');
  console.log('  ✅ Default admin created: admin / admin123');
}

module.exports = db;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
