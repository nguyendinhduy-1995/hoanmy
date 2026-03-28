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
    zalo_id TEXT DEFAULT '',
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
safeAddColumn('bookings', 'zalo_id', "TEXT DEFAULT ''");
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

// ==================== AD FUNNELS (shared funnel names) ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS ad_funnels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    crm_services TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );
`);
safeAddColumn('ad_funnels', 'crm_services', "TEXT DEFAULT ''");

// ==================== AD PERFORMANCE REPORTS ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS ad_performance_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date TEXT NOT NULL,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    funnel_name TEXT NOT NULL DEFAULT '',
    ad_cost INTEGER NOT NULL DEFAULT 0,
    leads_count INTEGER NOT NULL DEFAULT 0,
    data_count INTEGER NOT NULL DEFAULT 0,
    appointments_count INTEGER NOT NULL DEFAULT 0,
    arrivals_count INTEGER NOT NULL DEFAULT 0,
    first_revenue_total INTEGER NOT NULL DEFAULT 0,
    avg_first_revenue_kpi INTEGER NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    updated_at DATETIME DEFAULT (datetime('now', 'localtime')),
    UNIQUE(report_date, branch_id, funnel_name)
  );
  CREATE INDEX IF NOT EXISTS idx_adr_date ON ad_performance_reports(report_date);
  CREATE INDEX IF NOT EXISTS idx_adr_branch_date ON ad_performance_reports(branch_id, report_date);
  CREATE INDEX IF NOT EXISTS idx_adr_funnel_date ON ad_performance_reports(funnel_name, report_date);
`);
safeAddColumn('ad_performance_reports', 'data_count', "INTEGER NOT NULL DEFAULT 0");

// ==================== AUTO-MAP AD FUNNELS TO CRM SERVICES ====================
// One-time auto-mapping for existing funnels based on keyword matching
try {
  const unmappedFunnels = db.prepare("SELECT id, name FROM ad_funnels WHERE crm_services = '' OR crm_services IS NULL").all();
  if (unmappedFunnels.length > 0) {
    const distinctServices = db.prepare("SELECT DISTINCT interest_service FROM bookings WHERE interest_service != ''").all().map(r => r.interest_service);
    const updateStmt = db.prepare("UPDATE ad_funnels SET crm_services = ? WHERE id = ?");
    
    const mappingRules = [
      { pattern: /ch[aă]m\s*s[oó]c\s*da|csd/i, keywords: ['csd', 'chăm sóc da'] },
      { pattern: /gi[aả]m\s*b[eé]o/i, keywords: ['giảm béo'] },
      { pattern: /peel|p[eê]l/i, keywords: ['peel'] },
      { pattern: /phun\s*tr[aắ]ng/i, keywords: ['phun trắng'] },
      { pattern: /phun\s*x[aă]m/i, keywords: ['phun xăm', 'phun xam'] },
      { pattern: /tri[eệ]t\s*l[oô]ng/i, keywords: ['triệt lông'] },
      { pattern: /n[aá]m|đi[eề]u\s*tr[iị]\s*n[aá]m/i, keywords: ['nám', 'trị nám'] },
    ];

    for (const funnel of unmappedFunnels) {
      const matched = [];
      for (const rule of mappingRules) {
        if (rule.pattern.test(funnel.name)) {
          for (const svc of distinctServices) {
            const svcLower = svc.toLowerCase();
            if (rule.keywords.some(kw => svcLower.includes(kw.toLowerCase()))) {
              if (!matched.includes(svc)) matched.push(svc);
            }
          }
        }
      }
      if (matched.length > 0) {
        updateStmt.run(matched.join(','), funnel.id);
        console.log(`  ✅ Auto-mapped funnel "${funnel.name}" → [${matched.join(', ')}]`);
      }
    }
  }
} catch (e) { console.error('  ⚠️ Auto-map funnels error:', e.message); }

// ==================== DEMO DATA CLEANUP ====================
// Clean up seeded demo data. Demo leads have initial_note starting with 'Khách hỏi '
// and were created by the page operator seed account. We keep real data entered by truc_page.
try {
  const demoPhones = [
    '0901234567','0912345678','0923456789','0934567890','0945678901','0956789012','0967890123',
    '0978901234','0989012345','0990123456','0901111222','0912222333','0923333444','0934444555',
    '0945555666','0956666777','0967777888','0978888999','0989999000','0990000111','0901112233',
    '0912223344','0923334455','0934445566','0945556677','0956667788','0967778899','0978889900',
    '0989990011','0901223344','0912334455','0923445566','0934556677','0945667788','0956778899',
    '0967889900','0978990011','0989001122','0990112233','0901334455','0912445566','0923556677',
    '0934667788','0945778899','0956889900','0967990011','0978001122','0989112233','0990223344'
  ];
  const demoCount = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE phone IN (${demoPhones.map(() => '?').join(',')})`).get(...demoPhones).c;
  if (demoCount > 0) {
    const cleanupTx = db.transaction(() => {
      // Get demo booking IDs
      const demoIds = db.prepare(`SELECT id FROM bookings WHERE phone IN (${demoPhones.map(() => '?').join(',')})`).all(...demoPhones).map(r => r.id);
      if (demoIds.length > 0) {
        const idPlaceholders = demoIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM call_logs WHERE booking_id IN (${idPlaceholders})`).run(...demoIds);
        db.prepare(`DELETE FROM lead_events WHERE booking_id IN (${idPlaceholders})`).run(...demoIds);
        db.prepare(`DELETE FROM revenues WHERE booking_id IN (${idPlaceholders})`).run(...demoIds);
        db.prepare(`DELETE FROM bookings WHERE id IN (${idPlaceholders})`).run(...demoIds);
        console.log(`  ✅ Cleaned ${demoIds.length} demo leads and related data`);
      }
    });
    cleanupTx();
  }
} catch (e) {
  console.error('  ⚠️ Demo cleanup error:', e.message);
}

module.exports = db;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
