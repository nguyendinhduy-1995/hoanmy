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

// ==================== CORE SCHEMA ====================
db.exec(`
  -- Branches
  CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    address TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  -- Users
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'truc_page', 'telesale')),
    branch_id INTEGER REFERENCES branches(id),
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    last_login DATETIME
  );

  -- Sessions
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

  -- Leads (was bookings)
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    gender TEXT DEFAULT '',
    birth_year INTEGER,
    area TEXT DEFAULT '',
    source TEXT DEFAULT 'OTHER' CHECK(source IN ('FACEBOOK','ZALO','TIKTOK','HOTLINE','WALK_IN','LANDING','OTHER')),
    funnel_name TEXT DEFAULT '',
    interest_service TEXT DEFAULT '',
    service TEXT DEFAULT '',
    initial_note TEXT DEFAULT '',
    hot_level TEXT DEFAULT 'WARM' CHECK(hot_level IN ('HOT','WARM','COLD')),
    status TEXT DEFAULT 'NEW' CHECK(status IN ('NEW','ASSIGNED','CALLED','FOLLOW_UP','APPOINTED','ARRIVED','WON','LOST')),
    branch_id INTEGER REFERENCES branches(id),
    assigned_to INTEGER REFERENCES users(id),
    assigned_by INTEGER REFERENCES users(id),
    assigned_at DATETIME,
    created_by INTEGER REFERENCES users(id),
    called_count INTEGER DEFAULT 0,
    last_called_at DATETIME,
    last_call_outcome TEXT DEFAULT '',
    callback_at DATETIME,
    care_reminder_at DATETIME,
    appointment_at DATETIME,
    appointment_date TEXT DEFAULT '',
    arrived_at DATETIME,
    first_service_name TEXT DEFAULT '',
    first_revenue INTEGER DEFAULT 0,
    lost_reason TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
  CREATE INDEX IF NOT EXISTS idx_bookings_branch ON bookings(branch_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_assigned ON bookings(assigned_to);
  CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings(phone);
  CREATE INDEX IF NOT EXISTS idx_bookings_source ON bookings(source);
  CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(created_at);
  CREATE INDEX IF NOT EXISTS idx_bookings_callback ON bookings(callback_at);
  CREATE INDEX IF NOT EXISTS idx_bookings_care ON bookings(care_reminder_at);
  CREATE INDEX IF NOT EXISTS idx_bookings_appointment ON bookings(appointment_at);

  -- Lead Calls
  CREATE TABLE IF NOT EXISTS call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    call_number INTEGER NOT NULL,
    outcome TEXT DEFAULT 'NO_ANSWER' CHECK(outcome IN (
      'NO_ANSWER','WRONG_NUMBER','NOT_INTERESTED','CALL_BACK_LATER',
      'CARING','CONSULTED','APPOINTMENT_BOOKED','ARRIVED','CLOSED_FIRST_REVENUE','LOST'
    )),
    notes TEXT DEFAULT '',
    next_call_at DATETIME,
    care_reminder_at DATETIME,
    call_time DATETIME DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_call_logs_booking ON call_logs(booking_id);
  CREATE INDEX IF NOT EXISTS idx_call_logs_user ON call_logs(user_id);

  -- Lead Events (audit history for leads)
  CREATE TABLE IF NOT EXISTS lead_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT DEFAULT '',
    type TEXT NOT NULL,
    note TEXT DEFAULT '',
    old_value TEXT DEFAULT '',
    new_value TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lead_events_booking ON lead_events(booking_id);
  CREATE INDEX IF NOT EXISTS idx_lead_events_date ON lead_events(created_at);

  -- Revenue Entries
  CREATE TABLE IF NOT EXISTS revenues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    branch_id INTEGER REFERENCES branches(id),
    telesales_id INTEGER REFERENCES users(id),
    amount INTEGER NOT NULL,
    service_name TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_revenues_booking ON revenues(booking_id);
  CREATE INDEX IF NOT EXISTS idx_revenues_branch ON revenues(branch_id);
  CREATE INDEX IF NOT EXISTS idx_revenues_date ON revenues(created_at);

  -- Activity Logs (system audit)
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

  -- Landing page meta
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

  -- Page views
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

  -- Daily reports
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

// ==================== SEED BRANCHES ====================
const branchCount = db.prepare('SELECT COUNT(*) as c FROM branches').get().c;
if (branchCount === 0) {
  const insertBranch = db.prepare('INSERT INTO branches (code, name) VALUES (?, ?)');
  [
    ['TD', 'Viện Thẩm Mỹ Hoàn Mỹ - Thủ Đức'],
    ['LG', 'Viện Thẩm Mỹ Hoàn Mỹ - Lagi'],
    ['CR', 'Viện Thẩm Mỹ Hoàn Mỹ - Cam Ranh'],
    ['PR', 'Viện Thẩm Mỹ Hoàn Mỹ - Phan Rang'],
    ['BL', 'Viện Thẩm Mỹ Hoàn Mỹ - Bảo Lộc'],
  ].forEach(([code, name]) => insertBranch.run(code, name));
  console.log('  ✅ Seeded 5 branches');
} else {
  // Migrate existing branch names
  const branchUpdates = [
    [1, 'TD', 'Viện Thẩm Mỹ Hoàn Mỹ - Thủ Đức'],
    [2, 'LG', 'Viện Thẩm Mỹ Hoàn Mỹ - Lagi'],
    [3, 'CR', 'Viện Thẩm Mỹ Hoàn Mỹ - Cam Ranh'],
    [4, 'PR', 'Viện Thẩm Mỹ Hoàn Mỹ - Phan Rang'],
    [5, 'BL', 'Viện Thẩm Mỹ Hoàn Mỹ - Bảo Lộc'],
  ];
  const updateBranch = db.prepare('UPDATE branches SET code = ?, name = ? WHERE id = ?');
  branchUpdates.forEach(([id, code, name]) => {
    const current = db.prepare('SELECT name FROM branches WHERE id = ?').get(id);
    if (current && current.name !== name) {
      updateBranch.run(code, name, id);
      console.log(`  ✅ Updated branch ${id}: ${name}`);
    }
  });
}

// ==================== SAFE MIGRATIONS ====================
// For existing databases — add new columns if missing

const safeAddColumn = (table, col, def) => {
  try { db.prepare(`SELECT ${col} FROM ${table} LIMIT 1`).get(); }
  catch (e) { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); console.log(`  ✅ Added ${col} to ${table}`); }
};

// Lead (bookings) migrations
safeAddColumn('bookings', 'source', "TEXT DEFAULT 'OTHER'");
safeAddColumn('bookings', 'branch_id', "INTEGER REFERENCES branches(id)");
safeAddColumn('bookings', 'assigned_to', "INTEGER REFERENCES users(id)");
safeAddColumn('bookings', 'assigned_by', "INTEGER REFERENCES users(id)");
safeAddColumn('bookings', 'assigned_at', "DATETIME");
safeAddColumn('bookings', 'created_by', "INTEGER REFERENCES users(id)");
safeAddColumn('bookings', 'gender', "TEXT DEFAULT ''");
safeAddColumn('bookings', 'birth_year', "INTEGER");
safeAddColumn('bookings', 'area', "TEXT DEFAULT ''");
safeAddColumn('bookings', 'funnel_name', "TEXT DEFAULT ''");
safeAddColumn('bookings', 'interest_service', "TEXT DEFAULT ''");
safeAddColumn('bookings', 'initial_note', "TEXT DEFAULT ''");
safeAddColumn('bookings', 'hot_level', "TEXT DEFAULT 'WARM'");
safeAddColumn('bookings', 'called_count', "INTEGER DEFAULT 0");
safeAddColumn('bookings', 'last_called_at', "DATETIME");
safeAddColumn('bookings', 'last_call_outcome', "TEXT DEFAULT ''");
safeAddColumn('bookings', 'callback_at', "DATETIME");
safeAddColumn('bookings', 'care_reminder_at', "DATETIME");
safeAddColumn('bookings', 'appointment_at', "DATETIME");
safeAddColumn('bookings', 'arrived_at', "DATETIME");
safeAddColumn('bookings', 'first_service_name', "TEXT DEFAULT ''");
safeAddColumn('bookings', 'first_revenue', "INTEGER DEFAULT 0");
safeAddColumn('bookings', 'lost_reason', "TEXT DEFAULT ''");
safeAddColumn('bookings', 'updated_at', "DATETIME DEFAULT (datetime('now', 'localtime'))");

// Call logs migrations
safeAddColumn('call_logs', 'outcome', "TEXT DEFAULT 'NO_ANSWER'");
safeAddColumn('call_logs', 'next_call_at', "DATETIME");
safeAddColumn('call_logs', 'care_reminder_at', "DATETIME");

// Revenue migrations
safeAddColumn('revenues', 'branch_id', "INTEGER REFERENCES branches(id)");
safeAddColumn('revenues', 'telesales_id', "INTEGER REFERENCES users(id)");
safeAddColumn('revenues', 'service_name', "TEXT DEFAULT ''");

// Branch migrations
safeAddColumn('branches', 'code', "TEXT DEFAULT ''");
safeAddColumn('branches', 'address', "TEXT DEFAULT ''");
safeAddColumn('branches', 'phone', "TEXT DEFAULT ''");
safeAddColumn('branches', 'updated_at', "DATETIME DEFAULT (datetime('now', 'localtime'))");

// Users migration
safeAddColumn('users', 'branch_id', "INTEGER REFERENCES branches(id)");

// ==================== MIGRATE STATUS VALUES ====================
// Migrate old status values to new pipeline
try {
  const oldStatuses = db.prepare("SELECT DISTINCT status FROM bookings").all().map(r => r.status);
  const statusMap = { 'pending': 'NEW', 'arrived': 'ARRIVED', 'no_show': 'LOST' };
  Object.entries(statusMap).forEach(([old, neu]) => {
    if (oldStatuses.includes(old)) {
      db.prepare("UPDATE bookings SET status = ? WHERE status = ?").run(neu, old);
      console.log(`  ✅ Migrated status ${old} → ${neu}`);
    }
  });
} catch (e) { /* fresh DB, no migration needed */ }

// ==================== MIGRATE USERS TABLE (remove branch_manager) ====================
try {
  const hasBranchManager = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'branch_manager'").get().c;
  if (hasBranchManager > 0) {
    // Convert branch_managers to admins (closest role)
    db.prepare("UPDATE users SET role = 'admin' WHERE role = 'branch_manager'").run();
    console.log('  ✅ Converted branch_manager users to admin');
  }
} catch (e) { /* fresh DB */ }

// Rebuild users table if needed (remove branch_manager from CHECK constraint)
try {
  const testStmt = db.prepare("INSERT INTO users (username, password_hash, salt, display_name, role) VALUES ('__test_role__', 'x', 'x', 'x', 'truc_page')");
  try {
    testStmt.run();
    db.prepare("DELETE FROM users WHERE username = '__test_role__'").run();
  } catch (constraintErr) {
    if (constraintErr.message.includes('CHECK constraint')) {
      console.log('  🔄 Migrating users table to new role set...');
      db.pragma('foreign_keys = OFF');
      db.exec(`
        DROP TABLE IF EXISTS users_new;
        BEGIN TRANSACTION;
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          salt TEXT NOT NULL,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin', 'truc_page', 'telesale')),
          branch_id INTEGER REFERENCES branches(id),
          active INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT (datetime('now', 'localtime')),
          last_login DATETIME
        );
        INSERT INTO users_new (id, username, password_hash, salt, display_name, role, active, created_at, last_login, branch_id)
          SELECT id, username, password_hash, salt, display_name, role, active, created_at, last_login, branch_id FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        COMMIT;
      `);
      db.pragma('foreign_keys = ON');
      console.log('  ✅ Users table migrated (roles: admin, truc_page, telesale)');
    }
  }
} catch (e) {
  if (!e.message.includes('no such table')) {
    console.error('  ⚠️ Migration check error:', e.message);
  }
}

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

// ==================== SEED USERS ====================

// Admin accounts
const adminAccounts = [
  { username: 'admin', display: 'Admin', password: 'Admin@123' },
  { username: 'hoanmy', display: 'Hoàn Mỹ', password: 'hoanmy@123' },
];
adminAccounts.forEach(acc => {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(acc.username);
  if (!exists) {
    const { hash, salt } = hashPassword(acc.password);
    db.prepare('INSERT INTO users (username, password_hash, salt, display_name, role) VALUES (?, ?, ?, ?, ?)').run(acc.username, hash, salt, acc.display, 'admin');
    console.log(`  ✅ Created admin: ${acc.username}`);
  }
});

// Page Operator
const pageExists = db.prepare("SELECT id FROM users WHERE username = 'trucpage'").get();
if (!pageExists) {
  const { hash, salt } = hashPassword('trucpage@123');
  db.prepare('INSERT INTO users (username, password_hash, salt, display_name, role) VALUES (?, ?, ?, ?, ?)').run('trucpage', hash, salt, 'Trực Page', 'truc_page');
  console.log('  ✅ Created page operator: trucpage');
}

// 5 Telesales (one per branch)
const branches = db.prepare('SELECT id, name FROM branches ORDER BY id').all();
const telesaleAccounts = [
  { username: 'thuduc', password: 'thuduc@123' },
  { username: 'lagi', password: 'lagi@123' },
  { username: 'camranh', password: 'camranh@123' },
  { username: 'phanrang', password: 'phanrang@123' },
  { username: 'baoloc', password: 'baoloc@123' },
];
telesaleAccounts.forEach((acc, i) => {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(acc.username);
  if (!exists && branches[i]) {
    const branchShort = branches[i].name.replace('Viện Thẩm Mỹ Hoàn Mỹ - ', '');
    const displayName = `Telesales ${branchShort}`;
    const { hash, salt } = hashPassword(acc.password);
    db.prepare('INSERT INTO users (username, password_hash, salt, display_name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      acc.username, hash, salt, displayName, 'telesale', branches[i].id
    );
    console.log(`  ✅ Created telesales: ${acc.username} → ${branches[i].name}`);
  }
});

// ==================== SAMPLE DATA ====================
const existingLeads = db.prepare('SELECT COUNT(*) as c FROM bookings').get().c;
if (existingLeads === 0) {
  const allUsers = db.prepare('SELECT id, username, role, branch_id FROM users').all();
  const pageUser = allUsers.find(u => u.role === 'truc_page');
  const adminUser = allUsers.find(u => u.role === 'admin');
  const tsUsers = allUsers.filter(u => u.role === 'telesale');

  // Helper: date strings relative to now
  function daysAgo(n, hour = 10, min = 0) {
    const d = new Date(); d.setDate(d.getDate() - n); d.setHours(hour, min, 0, 0);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
  function today(hour = 10, min = 0) { return daysAgo(0, hour, min); }
  function yesterday(hour = 10, min = 0) { return daysAgo(1, hour, min); }

  const SERVICES = [
    'Nâng mũi cấu trúc', 'Cắt mí mắt', 'Tiêm filler', 'Botox', 'Căng chỉ',
    'Trẻ hóa da', 'Hút mỡ bụng', 'Nâng ngực', 'Tạo hình môi', 'Trị nám',
    'Laser CO2', 'Peel da', 'Mesotherapy', 'PRP trẻ hóa', 'Cấy mỡ mặt'
  ];
  const SOURCES = ['FACEBOOK', 'ZALO', 'TIKTOK', 'HOTLINE', 'WALK_IN', 'LANDING'];
  const FUNNELS = ['FB Ads Mũi', 'FB Ads Mắt', 'Zalo OA', 'TikTok Ads', 'Google Ads', 'Landing Page', 'Giới thiệu'];
  const AREAS = ['TP.HCM', 'Bình Dương', 'Đồng Nai', 'Long An', 'Lâm Đồng', 'Bình Thuận', 'Khánh Hòa', 'Ninh Thuận', 'Bà Rịa - Vũng Tàu', 'Tây Ninh'];

  const sampleLeads = [
    // ── Chi nhánh 1: Thủ Đức ─────────────────
    // WON (có doanh thu)
    { name:'Nguyễn Thị Mai', phone:'0901234567', gender:'F', year:1990, area:'TP.HCM', source:'FACEBOOK', funnel:'FB Ads Mũi', service:'Nâng mũi cấu trúc', hot:'HOT', status:'WON', branch:0, daysAgo:5, apptDays:3, arrivedDays:3, revenue:15000000, revenueService:'Nâng mũi cấu trúc', calls:[{outcome:'CONSULTED',days:5},{outcome:'APPOINTMENT_BOOKED',days:4},{outcome:'ARRIVED',days:3},{outcome:'CLOSED_FIRST_REVENUE',days:3}] },
    { name:'Trần Văn Hùng', phone:'0912345678', gender:'M', year:1985, area:'Bình Dương', source:'ZALO', funnel:'Zalo OA', service:'Hút mỡ bụng', hot:'HOT', status:'WON', branch:0, daysAgo:7, apptDays:4, arrivedDays:4, revenue:25000000, revenueService:'Hút mỡ bụng', calls:[{outcome:'CONSULTED',days:7},{outcome:'APPOINTMENT_BOOKED',days:6},{outcome:'ARRIVED',days:4},{outcome:'CLOSED_FIRST_REVENUE',days:4}] },
    // ARRIVED (đã đến hôm qua — cần chăm sóc)
    { name:'Lê Thị Hồng', phone:'0923456789', gender:'F', year:1995, area:'TP.HCM', source:'TIKTOK', funnel:'TikTok Ads', service:'Cắt mí mắt', hot:'HOT', status:'ARRIVED', branch:0, daysAgo:3, apptDays:1, arrivedDays:1, calls:[{outcome:'CONSULTED',days:3},{outcome:'APPOINTMENT_BOOKED',days:2},{outcome:'ARRIVED',days:1}] },
    { name:'Phạm Minh Tuấn', phone:'0934567890', gender:'M', year:1988, area:'Đồng Nai', source:'FACEBOOK', funnel:'FB Ads Mắt', service:'Tiêm filler', hot:'WARM', status:'ARRIVED', branch:0, daysAgo:4, apptDays:1, arrivedDays:1, calls:[{outcome:'CONSULTED',days:4},{outcome:'APPOINTMENT_BOOKED',days:2},{outcome:'ARRIVED',days:1}] },
    // APPOINTED (có hẹn hôm nay)
    { name:'Võ Thị Lan', phone:'0945678901', gender:'F', year:1992, area:'TP.HCM', source:'HOTLINE', funnel:'', service:'Botox', hot:'HOT', status:'APPOINTED', branch:0, daysAgo:2, apptDays:0, calls:[{outcome:'CONSULTED',days:2},{outcome:'APPOINTMENT_BOOKED',days:1}] },
    { name:'Đặng Quốc Bảo', phone:'0956789012', gender:'M', year:1980, area:'Long An', source:'FACEBOOK', funnel:'FB Ads Mũi', service:'Nâng mũi cấu trúc', hot:'WARM', status:'APPOINTED', branch:0, daysAgo:3, apptDays:0, calls:[{outcome:'CALL_BACK_LATER',days:3},{outcome:'CONSULTED',days:2},{outcome:'APPOINTMENT_BOOKED',days:1}] },
    // APPOINTED (có hẹn hôm qua nhưng chưa đến — no-show)
    { name:'Huỳnh Thị Ngọc', phone:'0967890123', gender:'F', year:1993, area:'Bình Dương', source:'ZALO', funnel:'Zalo OA', service:'Căng chỉ', hot:'WARM', status:'APPOINTED', branch:0, daysAgo:4, apptDays:1, calls:[{outcome:'CONSULTED',days:4},{outcome:'APPOINTMENT_BOOKED',days:2}] },
    // CALLED / FOLLOW_UP
    { name:'Bùi Văn Đức', phone:'0978901234', gender:'M', year:1987, area:'TP.HCM', source:'TIKTOK', funnel:'TikTok Ads', service:'Trẻ hóa da', hot:'WARM', status:'FOLLOW_UP', branch:0, daysAgo:1, calls:[{outcome:'CARING',days:1}], callbackDays:1 },
    { name:'Ngô Thị Thảo', phone:'0989012345', gender:'F', year:1998, area:'TP.HCM', source:'FACEBOOK', funnel:'FB Ads Mắt', service:'Cắt mí mắt', hot:'COLD', status:'CALLED', branch:0, daysAgo:0, calls:[{outcome:'CALL_BACK_LATER',days:0}], callbackDays:2 },
    // NEW
    { name:'Lý Thanh Tùng', phone:'0990123456', gender:'M', year:1991, area:'Tây Ninh', source:'LANDING', funnel:'Landing Page', service:'Laser CO2', hot:'WARM', status:'NEW', branch:0, daysAgo:0 },

    // ── Chi nhánh 2: Lagi ─────────────────
    { name:'Trương Thị Bích', phone:'0901111222', gender:'F', year:1994, area:'Bình Thuận', source:'FACEBOOK', funnel:'FB Ads Mũi', service:'Nâng mũi cấu trúc', hot:'HOT', status:'WON', branch:1, daysAgo:6, apptDays:3, arrivedDays:3, revenue:18000000, revenueService:'Nâng mũi cấu trúc', calls:[{outcome:'CONSULTED',days:6},{outcome:'APPOINTMENT_BOOKED',days:5},{outcome:'ARRIVED',days:3},{outcome:'CLOSED_FIRST_REVENUE',days:3}] },
    { name:'Phan Văn Sơn', phone:'0912222333', gender:'M', year:1982, area:'Bình Thuận', source:'HOTLINE', funnel:'', service:'Cấy mỡ mặt', hot:'HOT', status:'WON', branch:1, daysAgo:4, apptDays:2, arrivedDays:2, revenue:12000000, revenueService:'Cấy mỡ mặt', calls:[{outcome:'CONSULTED',days:4},{outcome:'APPOINTMENT_BOOKED',days:3},{outcome:'ARRIVED',days:2},{outcome:'CLOSED_FIRST_REVENUE',days:2}] },
    { name:'Đỗ Thị Hạnh', phone:'0923333444', gender:'F', year:1996, area:'Bình Thuận', source:'ZALO', funnel:'Zalo OA', service:'Trị nám', hot:'WARM', status:'ARRIVED', branch:1, daysAgo:3, apptDays:1, arrivedDays:1, calls:[{outcome:'CONSULTED',days:3},{outcome:'APPOINTMENT_BOOKED',days:2},{outcome:'ARRIVED',days:1}] },
    { name:'Mai Xuân Trường', phone:'0934444555', gender:'M', year:1989, area:'Bình Thuận', source:'TIKTOK', funnel:'TikTok Ads', service:'Botox', hot:'HOT', status:'APPOINTED', branch:1, daysAgo:2, apptDays:0, calls:[{outcome:'CONSULTED',days:2},{outcome:'APPOINTMENT_BOOKED',days:1}] },
    { name:'Hồ Thị Mỹ Duyên', phone:'0945555666', gender:'F', year:1997, area:'Bình Thuận', source:'FACEBOOK', funnel:'FB Ads Mắt', service:'Cắt mí mắt', hot:'WARM', status:'APPOINTED', branch:1, daysAgo:3, apptDays:1, calls:[{outcome:'CONSULTED',days:3},{outcome:'APPOINTMENT_BOOKED',days:2}] },
    { name:'Lâm Quốc Việt', phone:'0956666777', gender:'M', year:1986, area:'Bình Thuận', source:'WALK_IN', funnel:'', service:'PRP trẻ hóa', hot:'WARM', status:'FOLLOW_UP', branch:1, daysAgo:1, calls:[{outcome:'CARING',days:1}], callbackDays:0 },
    { name:'Cao Thị Liên', phone:'0967777888', gender:'F', year:2000, area:'Bình Thuận', source:'LANDING', funnel:'Landing Page', service:'Peel da', hot:'COLD', status:'CALLED', branch:1, daysAgo:0, calls:[{outcome:'NOT_INTERESTED',days:0}] },
    { name:'Tạ Đình Phú', phone:'0978888999', gender:'M', year:1984, area:'Bình Thuận', source:'FACEBOOK', funnel:'FB Ads Mũi', service:'Nâng mũi cấu trúc', hot:'WARM', status:'NEW', branch:1, daysAgo:0 },
    { name:'Vương Thị Ngân', phone:'0989999000', gender:'F', year:1993, area:'Bình Thuận', source:'ZALO', funnel:'Zalo OA', service:'Mesotherapy', hot:'WARM', status:'NEW', branch:1, daysAgo:0 },
    { name:'Đinh Thị Thu', phone:'0990000111', gender:'F', year:1991, area:'Bình Thuận', source:'TIKTOK', funnel:'TikTok Ads', service:'Tiêm filler', hot:'HOT', status:'ASSIGNED', branch:1, daysAgo:0 },

    // ── Chi nhánh 3: Cam Ranh ─────────────────
    { name:'Nguyễn Thị Thanh Hà', phone:'0901112233', gender:'F', year:1988, area:'Khánh Hòa', source:'FACEBOOK', funnel:'FB Ads Mũi', service:'Nâng mũi cấu trúc', hot:'HOT', status:'WON', branch:2, daysAgo:5, apptDays:2, arrivedDays:2, revenue:20000000, revenueService:'Nâng mũi cấu trúc', calls:[{outcome:'CONSULTED',days:5},{outcome:'APPOINTMENT_BOOKED',days:3},{outcome:'ARRIVED',days:2},{outcome:'CLOSED_FIRST_REVENUE',days:2}] },
    { name:'Lê Hoàng Nam', phone:'0912223344', gender:'M', year:1990, area:'Khánh Hòa', source:'HOTLINE', funnel:'', service:'Căng chỉ', hot:'HOT', status:'ARRIVED', branch:2, daysAgo:3, apptDays:1, arrivedDays:1, calls:[{outcome:'CONSULTED',days:3},{outcome:'APPOINTMENT_BOOKED',days:2},{outcome:'ARRIVED',days:1}] },
    { name:'Phạm Thị Kim Oanh', phone:'0923334455', gender:'F', year:1995, area:'Khánh Hòa', source:'ZALO', funnel:'Zalo OA', service:'Tiêm filler', hot:'WARM', status:'APPOINTED', branch:2, daysAgo:2, apptDays:0, calls:[{outcome:'CONSULTED',days:2},{outcome:'APPOINTMENT_BOOKED',days:1}] },
    { name:'Trần Quang Minh', phone:'0934445566', gender:'M', year:1983, area:'Khánh Hòa', source:'TIKTOK', funnel:'TikTok Ads', service:'Hút mỡ bụng', hot:'HOT', status:'APPOINTED', branch:2, daysAgo:4, apptDays:1, calls:[{outcome:'CONSULTED',days:4},{outcome:'APPOINTMENT_BOOKED',days:2}] },
    { name:'Võ Thị Phương', phone:'0945556677', gender:'F', year:1997, area:'Khánh Hòa', source:'FACEBOOK', funnel:'FB Ads Mắt', service:'Cắt mí mắt', hot:'WARM', status:'FOLLOW_UP', branch:2, daysAgo:1, calls:[{outcome:'CARING',days:1}], callbackDays:1 },
    { name:'Đặng Anh Tuấn', phone:'0956667788', gender:'M', year:1992, area:'Khánh Hòa', source:'LANDING', funnel:'Landing Page', service:'Laser CO2', hot:'COLD', status:'CALLED', branch:2, daysAgo:0, calls:[{outcome:'CALL_BACK_LATER',days:0}], callbackDays:3 },
    { name:'Huỳnh Thị Diệu', phone:'0967778899', gender:'F', year:1999, area:'Khánh Hòa', source:'WALK_IN', funnel:'', service:'Trẻ hóa da', hot:'WARM', status:'NEW', branch:2, daysAgo:0 },
    { name:'Bùi Minh Đạt', phone:'0978889900', gender:'M', year:1987, area:'Khánh Hòa', source:'FACEBOOK', funnel:'FB Ads Mũi', service:'Nâng mũi cấu trúc', hot:'HOT', status:'NEW', branch:2, daysAgo:0 },
    // LOST
    { name:'Ngô Thị Yến', phone:'0989990011', gender:'F', year:1994, area:'Khánh Hòa', source:'TIKTOK', funnel:'TikTok Ads', service:'Botox', hot:'COLD', status:'LOST', branch:2, daysAgo:6, calls:[{outcome:'NOT_INTERESTED',days:6},{outcome:'LOST',days:5}], lostReason:'Không quan tâm' },

    // ── Chi nhánh 4: Phan Rang ─────────────────
    { name:'Trương Thị Hương', phone:'0901223344', gender:'F', year:1991, area:'Ninh Thuận', source:'FACEBOOK', funnel:'FB Ads Mũi', service:'Nâng mũi cấu trúc', hot:'HOT', status:'WON', branch:3, daysAgo:4, apptDays:2, arrivedDays:2, revenue:16000000, revenueService:'Nâng mũi cấu trúc', calls:[{outcome:'CONSULTED',days:4},{outcome:'APPOINTMENT_BOOKED',days:3},{outcome:'ARRIVED',days:2},{outcome:'CLOSED_FIRST_REVENUE',days:2}] },
    { name:'Phan Minh Quân', phone:'0912334455', gender:'M', year:1986, area:'Ninh Thuận', source:'ZALO', funnel:'Zalo OA', service:'Cấy mỡ mặt', hot:'HOT', status:'ARRIVED', branch:3, daysAgo:3, apptDays:1, arrivedDays:1, calls:[{outcome:'CONSULTED',days:3},{outcome:'APPOINTMENT_BOOKED',days:2},{outcome:'ARRIVED',days:1}] },
    { name:'Đỗ Thị Loan', phone:'0923445566', gender:'F', year:1996, area:'Ninh Thuận', source:'HOTLINE', funnel:'', service:'Trị nám', hot:'WARM', status:'APPOINTED', branch:3, daysAgo:2, apptDays:0, calls:[{outcome:'CONSULTED',days:2},{outcome:'APPOINTMENT_BOOKED',days:1}] },
    { name:'Mai Văn Khoa', phone:'0934556677', gender:'M', year:1984, area:'Ninh Thuận', source:'TIKTOK', funnel:'TikTok Ads', service:'PRP trẻ hóa', hot:'WARM', status:'APPOINTED', branch:3, daysAgo:5, apptDays:1, calls:[{outcome:'CONSULTED',days:5},{outcome:'APPOINTMENT_BOOKED',days:3}] },
    { name:'Hồ Thị Kim Chi', phone:'0945667788', gender:'F', year:1998, area:'Ninh Thuận', source:'FACEBOOK', funnel:'FB Ads Mắt', service:'Cắt mí mắt', hot:'HOT', status:'FOLLOW_UP', branch:3, daysAgo:1, calls:[{outcome:'CARING',days:1}], callbackDays:0 },
    { name:'Lâm Đức Trí', phone:'0956778899', gender:'M', year:1989, area:'Ninh Thuận', source:'LANDING', funnel:'Landing Page', service:'Mesotherapy', hot:'COLD', status:'CALLED', branch:3, daysAgo:0, calls:[{outcome:'NO_ANSWER',days:0}] },
    { name:'Cao Thị Bích Ngọc', phone:'0967889900', gender:'F', year:2001, area:'Ninh Thuận', source:'WALK_IN', funnel:'', service:'Peel da', hot:'WARM', status:'NEW', branch:3, daysAgo:0 },
    { name:'Tạ Minh Hoàng', phone:'0978990011', gender:'M', year:1985, area:'Ninh Thuận', source:'FACEBOOK', funnel:'', service:'Botox', hot:'WARM', status:'NEW', branch:3, daysAgo:0 },
    { name:'Vương Thị Tuyết', phone:'0989001122', gender:'F', year:1993, area:'Ninh Thuận', source:'ZALO', funnel:'Zalo OA', service:'Tiêm filler', hot:'HOT', status:'ASSIGNED', branch:3, daysAgo:0 },
    { name:'Đinh Quốc Anh', phone:'0990112233', gender:'M', year:1990, area:'Ninh Thuận', source:'TIKTOK', funnel:'TikTok Ads', service:'Hút mỡ bụng', hot:'COLD', status:'LOST', branch:3, daysAgo:7, calls:[{outcome:'NOT_INTERESTED',days:7},{outcome:'LOST',days:6}], lostReason:'Giá cao' },

    // ── Chi nhánh 5: Bảo Lộc ─────────────────
    { name:'Nguyễn Thị Cẩm Tú', phone:'0901334455', gender:'F', year:1992, area:'Lâm Đồng', source:'FACEBOOK', funnel:'FB Ads Mũi', service:'Nâng mũi cấu trúc', hot:'HOT', status:'WON', branch:4, daysAgo:6, apptDays:3, arrivedDays:3, revenue:22000000, revenueService:'Nâng mũi cấu trúc', calls:[{outcome:'CONSULTED',days:6},{outcome:'APPOINTMENT_BOOKED',days:5},{outcome:'ARRIVED',days:3},{outcome:'CLOSED_FIRST_REVENUE',days:3}] },
    { name:'Lê Văn Phúc', phone:'0912445566', gender:'M', year:1987, area:'Lâm Đồng', source:'ZALO', funnel:'Zalo OA', service:'Căng chỉ', hot:'HOT', status:'WON', branch:4, daysAgo:5, apptDays:2, arrivedDays:2, revenue:10000000, revenueService:'Căng chỉ', calls:[{outcome:'CONSULTED',days:5},{outcome:'APPOINTMENT_BOOKED',days:3},{outcome:'ARRIVED',days:2},{outcome:'CLOSED_FIRST_REVENUE',days:2}] },
    { name:'Phạm Thị Ngọc Ánh', phone:'0923556677', gender:'F', year:1995, area:'Lâm Đồng', source:'HOTLINE', funnel:'', service:'Trẻ hóa da', hot:'WARM', status:'ARRIVED', branch:4, daysAgo:2, apptDays:1, arrivedDays:1, calls:[{outcome:'CONSULTED',days:2},{outcome:'APPOINTMENT_BOOKED',days:1},{outcome:'ARRIVED',days:1}] },
    { name:'Trần Đức Huy', phone:'0934667788', gender:'M', year:1983, area:'Lâm Đồng', source:'TIKTOK', funnel:'TikTok Ads', service:'Hút mỡ bụng', hot:'HOT', status:'APPOINTED', branch:4, daysAgo:2, apptDays:0, calls:[{outcome:'CONSULTED',days:2},{outcome:'APPOINTMENT_BOOKED',days:1}] },
    { name:'Võ Thị Kim Thoa', phone:'0945778899', gender:'F', year:1997, area:'Lâm Đồng', source:'FACEBOOK', funnel:'FB Ads Mắt', service:'Cắt mí mắt', hot:'WARM', status:'APPOINTED', branch:4, daysAgo:4, apptDays:1, calls:[{outcome:'CONSULTED',days:4},{outcome:'APPOINTMENT_BOOKED',days:2}] },
    { name:'Đặng Minh Trung', phone:'0956889900', gender:'M', year:1990, area:'Lâm Đồng', source:'WALK_IN', funnel:'', service:'Laser CO2', hot:'WARM', status:'FOLLOW_UP', branch:4, daysAgo:1, calls:[{outcome:'CARING',days:1}], callbackDays:2 },
    { name:'Huỳnh Thị Thanh Trúc', phone:'0967990011', gender:'F', year:1999, area:'Lâm Đồng', source:'LANDING', funnel:'Landing Page', service:'Peel da', hot:'COLD', status:'CALLED', branch:4, daysAgo:0, calls:[{outcome:'CALL_BACK_LATER',days:0}], callbackDays:3 },
    { name:'Bùi Quang Hải', phone:'0978001122', gender:'M', year:1988, area:'Lâm Đồng', source:'FACEBOOK', funnel:'FB Ads Mũi', service:'Cấy mỡ mặt', hot:'HOT', status:'NEW', branch:4, daysAgo:0 },
    { name:'Ngô Thị Phương Uyên', phone:'0989112233', gender:'F', year:2000, area:'Lâm Đồng', source:'ZALO', funnel:'Zalo OA', service:'Tiêm filler', hot:'WARM', status:'NEW', branch:4, daysAgo:0 },
    { name:'Lý Hoàng Long', phone:'0990223344', gender:'M', year:1986, area:'Lâm Đồng', source:'TIKTOK', funnel:'TikTok Ads', service:'Botox', hot:'COLD', status:'LOST', branch:4, daysAgo:8, calls:[{outcome:'WRONG_NUMBER',days:8}], lostReason:'Sai số' },
  ];

  const insertBooking = db.prepare(`INSERT INTO bookings (
    full_name, phone, gender, birth_year, area, source, funnel_name, interest_service, service,
    initial_note, hot_level, status, branch_id, assigned_to, assigned_by, assigned_at, created_by,
    called_count, last_called_at, last_call_outcome, callback_at, care_reminder_at,
    appointment_at, appointment_date, arrived_at, first_service_name, first_revenue, lost_reason, notes,
    created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const insertCall = db.prepare(`INSERT INTO call_logs (booking_id, user_id, username, call_number, outcome, notes, next_call_at, care_reminder_at, call_time) VALUES (?,?,?,?,?,?,?,?,?)`);
  const insertRevenue = db.prepare(`INSERT INTO revenues (booking_id, branch_id, telesales_id, amount, service_name, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)`);
  const insertEvent = db.prepare(`INSERT INTO lead_events (booking_id, user_id, username, type, note, old_value, new_value, created_at) VALUES (?,?,?,?,?,?,?,?)`);

  const seedAll = db.transaction(() => {
    sampleLeads.forEach(l => {
      const br = branches[l.branch];
      const ts = tsUsers.find(u => u.branch_id === br.id);
      const isAssigned = l.status !== 'NEW';
      const createdAt = daysAgo(l.daysAgo, 8 + Math.floor(Math.random() * 4), Math.floor(Math.random() * 60));
      const assignedAt = isAssigned ? daysAgo(l.daysAgo, 9, 0) : null;
      const apptAt = l.apptDays !== undefined ? daysAgo(l.apptDays, 14, 0) : null;
      const arrivedAt = l.arrivedDays !== undefined ? daysAgo(l.arrivedDays, 15, 0) : null;
      const callbackAt = l.callbackDays !== undefined ? daysAgo(-l.callbackDays, 9, 0) : null;
      const careAt = l.arrivedDays === 1 ? today(9, 0) : null;
      const lastCall = l.calls ? l.calls[l.calls.length - 1] : null;

      const info = insertBooking.run(
        l.name, l.phone, l.gender, l.year, l.area, l.source, l.funnel, l.service, l.service,
        `Khách hỏi ${l.service}`, l.hot, l.status, br.id,
        isAssigned && ts ? ts.id : null, isAssigned ? (pageUser ? pageUser.id : adminUser.id) : null, assignedAt, pageUser ? pageUser.id : adminUser.id,
        l.calls ? l.calls.length : 0,
        lastCall ? daysAgo(lastCall.days, 10, 30) : null,
        lastCall ? lastCall.outcome : '',
        callbackAt, careAt,
        apptAt, apptAt ? apptAt.slice(0, 10) : '',
        arrivedAt,
        l.revenueService || '', l.revenue || 0, l.lostReason || '',
        l.calls && l.calls.length > 0 ? `Gọi ${l.calls.length} lần` : '',
        createdAt, lastCall ? daysAgo(lastCall.days, 10, 30) : createdAt
      );
      const bookingId = info.lastInsertRowid;

      // Insert call logs
      if (l.calls && ts) {
        l.calls.forEach((c, ci) => {
          const callNotes = {
            'CONSULTED': 'Đã tư vấn, khách quan tâm',
            'APPOINTMENT_BOOKED': `Hẹn ${l.service}`,
            'ARRIVED': 'Khách đã đến',
            'CLOSED_FIRST_REVENUE': `Đóng doanh thu ${l.service}`,
            'CARING': 'Chăm sóc thêm',
            'CALL_BACK_LATER': 'Khách hẹn gọi lại',
            'NOT_INTERESTED': 'Không quan tâm',
            'NO_ANSWER': 'Không nghe máy',
            'WRONG_NUMBER': 'Sai số',
            'LOST': l.lostReason || 'Mất khách'
          };
          insertCall.run(
            bookingId, ts.id, ts.username || '', ci + 1, c.outcome,
            callNotes[c.outcome] || '', null, null, daysAgo(c.days, 10 + ci, 15 * ci)
          );
        });
      }

      // Insert revenue
      if (l.revenue && ts) {
        insertRevenue.run(bookingId, br.id, ts.id, l.revenue, l.revenueService || l.service, '', adminUser ? adminUser.id : 1, daysAgo(l.arrivedDays, 16, 0));
      }

      // Insert events
      insertEvent.run(bookingId, pageUser ? pageUser.id : 1, pageUser ? pageUser.username : 'admin', 'CREATED', `Thêm khách ${l.name}`, '', 'NEW', createdAt);
      if (isAssigned && ts) {
        insertEvent.run(bookingId, pageUser ? pageUser.id : 1, pageUser ? pageUser.username : 'admin', 'ASSIGNED', `Phân cho ${ts.username}`, 'NEW', 'ASSIGNED', assignedAt);
      }
    });
  });
  seedAll();
  console.log(`  ✅ Seeded ${sampleLeads.length} sample leads with calls, revenues, events`);
}

module.exports = db;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
