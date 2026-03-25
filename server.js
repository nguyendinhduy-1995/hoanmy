require("dotenv").config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const db = require('./database');
const { hashPassword, verifyPassword } = db;

const app = express();
const PORT = process.env.PORT || 3000;

// Helper: get Vietnam (UTC+7) date string 'YYYY-MM-DD'
function vnDateStr(d) {
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// Middleware
app.use(cors());
app.use(express.json());

// ==================== AUTH HELPERS ====================

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function logActivity(userId, username, role, action, detail, ip) {
    db.prepare(`INSERT INTO activity_logs (user_id, username, role, action, detail, ip_address) VALUES (?, ?, ?, ?, ?, ?)`).run(userId, username, role, action, detail, ip || '');
}

function logLeadEvent(bookingId, userId, username, type, note, oldValue, newValue) {
    db.prepare(`INSERT INTO lead_events (booking_id, user_id, username, type, note, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(bookingId, userId, username || '', type, note || '', oldValue || '', newValue || '');
}

// Auth middleware
function auth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });

    const session = db.prepare(`
        SELECT s.*, u.id as user_id, u.username, u.display_name, u.role, u.active, u.branch_id
        FROM sessions s JOIN users u ON s.user_id = u.id
        WHERE s.token = ? AND s.expires_at > datetime('now', 'localtime')
    `).get(token);

    if (!session || !session.active) return res.status(401).json({ error: 'Phiên đăng nhập hết hạn' });

    req.user = {
        id: session.user_id,
        username: session.username,
        displayName: session.display_name,
        role: session.role,
        branchId: session.branch_id
    };
    next();
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Không có quyền truy cập' });
        next();
    };
}

// ==================== STATIC FILES ====================

app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));
app.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));
app.use('/manifest.json', express.static(path.join(__dirname, 'public', 'manifest.json')));
app.use('/sw.js', express.static(path.join(__dirname, 'public', 'sw.js')));

// ==================== PUBLIC BOOKING (from landing pages) ====================

app.post('/api/bookings', (req, res) => {
    try {
        const { full_name, phone, service, appointment_date, notes } = req.body;
        if (!full_name || !phone || !service || !appointment_date) {
            return res.status(400).json({ error: 'Vui lòng điền đầy đủ thông tin' });
        }
        const phoneRegex = /^(0|\+84)[0-9]{9,10}$/;
        if (!phoneRegex.test(phone.replace(/\s/g, ''))) {
            return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
        }

        const result = db.prepare(`
            INSERT INTO bookings (full_name, phone, service, appointment_date, notes, source, status)
            VALUES (?, ?, ?, ?, ?, 'LANDING', 'NEW')
        `).run(full_name.trim(), phone.trim(), service.trim(), appointment_date, notes || '');

        const newBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);
        logActivity(null, 'Khách hàng', 'guest', 'lead_created', `${full_name} - ${phone} - ${service}`, req.ip);

        res.status(201).json({ message: 'Đặt lịch thành công!', booking: newBooking });
    } catch (error) {
        console.error('Error creating booking:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== AUTH ROUTES ====================

app.post('/api/login', (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Vui lòng nhập username và mật khẩu' });

        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (!user || !user.active) return res.status(401).json({ error: 'Tài khoản không tồn tại hoặc đã bị khóa' });

        if (!verifyPassword(password, user.password_hash, user.salt)) {
            logActivity(user.id, user.username, user.role, 'login_failed', 'Sai mật khẩu', req.ip);
            return res.status(401).json({ error: 'Mật khẩu không đúng' });
        }

        const token = generateToken();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expiresAt);
        db.prepare("UPDATE users SET last_login = datetime('now', 'localtime') WHERE id = ?").run(user.id);
        logActivity(user.id, user.username, user.role, 'login', 'Đăng nhập thành công', req.ip);

        res.json({
            token,
            user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role, branchId: user.branch_id }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

app.post('/api/logout', auth, (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    logActivity(req.user.id, req.user.username, req.user.role, 'logout', 'Đăng xuất', req.ip);
    res.json({ message: 'Đã đăng xuất' });
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

// ==================== LEADS (BOOKINGS) API ====================

// List leads (scoped by role)
app.get('/api/bookings', auth, (req, res) => {
    try {
        const { status, search, sort, order, branch_id, source, hot_level, uncalled } = req.query;

        let query = `SELECT b.*,
            br.name as branch_name,
            ua.display_name as assigned_to_name,
            uc.display_name as created_by_name
            FROM bookings b
            LEFT JOIN branches br ON b.branch_id = br.id
            LEFT JOIN users ua ON b.assigned_to = ua.id
            LEFT JOIN users uc ON b.created_by = uc.id
            WHERE 1=1`;
        const params = [];

        // Role-based scoping
        if (req.user.role === 'telesale' && req.user.branchId) {
            query += ' AND b.branch_id = ?';
            params.push(req.user.branchId);
        }

        if (branch_id) { query += ' AND b.branch_id = ?'; params.push(branch_id); }
        if (status) { query += ' AND b.status = ?'; params.push(status); }
        if (source) { query += ' AND b.source = ?'; params.push(source); }
        if (hot_level) { query += ' AND b.hot_level = ?'; params.push(hot_level); }
        if (search) {
            query += ' AND (b.full_name LIKE ? OR b.phone LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }
        if (uncalled === 'true') {
            query += ' AND b.called_count = 0';
        }

        const validSortFields = ['id', 'full_name', 'phone', 'created_at', 'status', 'hot_level', 'appointment_at'];
        const sortField = validSortFields.includes(sort) ? 'b.' + sort : 'b.created_at';
        const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
        query += ` ORDER BY ${sortField} ${sortOrder}`;

        const bookings = db.prepare(query).all(...params);

        // Stats scoped same way
        let scopeWhere = '';
        const scopeParams = [];
        if (req.user.role === 'telesale' && req.user.branchId) {
            scopeWhere = ' AND branch_id = ?';
            scopeParams.push(req.user.branchId);
        }

        const today = vnDateStr(new Date());
        const stats = {
            total: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE 1=1${scopeWhere}`).get(...scopeParams).c,
            new: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status = 'NEW'${scopeWhere}`).get(...scopeParams).c,
            assigned: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status = 'ASSIGNED'${scopeWhere}`).get(...scopeParams).c,
            called: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status = 'CALLED'${scopeWhere}`).get(...scopeParams).c,
            follow_up: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status = 'FOLLOW_UP'${scopeWhere}`).get(...scopeParams).c,
            appointed: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status = 'APPOINTED'${scopeWhere}`).get(...scopeParams).c,
            arrived: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status = 'ARRIVED'${scopeWhere}`).get(...scopeParams).c,
            won: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status = 'WON'${scopeWhere}`).get(...scopeParams).c,
            lost: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status = 'LOST'${scopeWhere}`).get(...scopeParams).c,
            today: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE DATE(created_at) = ?${scopeWhere}`).get(today, ...scopeParams).c,
            callbacks_due: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE callback_at IS NOT NULL AND DATE(callback_at) <= ?${scopeWhere}`).get(today, ...scopeParams).c,
            care_due: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE care_reminder_at IS NOT NULL AND DATE(care_reminder_at) <= ?${scopeWhere}`).get(today, ...scopeParams).c,
        };

        res.json({ bookings, stats });
    } catch (error) {
        console.error('Error fetching bookings:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// Create lead (manual entry by page operator)
app.post('/api/bookings/manual', auth, (req, res) => {
    try {
        const { full_name, phone, service, interest_service, source, funnel_name, hot_level, initial_note, branch_id, gender, birth_year, area, notes, appointment_date } = req.body;

        if (!full_name || !phone) {
            return res.status(400).json({ error: 'Vui lòng nhập họ tên và SĐT' });
        }

        const phoneClean = phone.replace(/\s/g, '');
        const phoneRegex = /^(0|\+84)[0-9]{9,10}$/;
        if (!phoneRegex.test(phoneClean)) {
            return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
        }

        // Duplicate detection
        const existing = db.prepare(`
            SELECT b.*, br.name as branch_name FROM bookings b
            LEFT JOIN branches br ON b.branch_id = br.id
            WHERE b.phone = ? OR b.phone = ?
            ORDER BY b.created_at DESC LIMIT 1
        `).get(phoneClean, phone.trim());

        if (existing) {
            return res.status(409).json({
                error: 'duplicate',
                message: `Lead này đã tồn tại ở ${existing.branch_name || 'chưa phân CN'}, trạng thái ${existing.status}, ngày tạo ${existing.created_at}`,
                existing_lead: existing
            });
        }

        // Auto-assign telesales if branch is selected
        let assignedTo = null;
        let leadStatus = 'NEW';
        if (branch_id) {
            const telesale = db.prepare("SELECT id FROM users WHERE branch_id = ? AND role = 'telesale' AND active = 1 LIMIT 1").get(branch_id);
            assignedTo = telesale ? telesale.id : null;
            leadStatus = 'ASSIGNED';
        }

        const result = db.prepare(`
            INSERT INTO bookings (full_name, phone, gender, birth_year, area, source, funnel_name, interest_service, service, initial_note, hot_level, status, branch_id, assigned_to, assigned_by, assigned_at, created_by, appointment_date, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${branch_id ? "datetime('now','localtime')" : 'NULL'}, ?, ?, ?)
        `).run(
            full_name.trim(), phoneClean,
            gender || '', birth_year || null, area || '',
            source || 'OTHER', funnel_name || '', interest_service || '', service || interest_service || '',
            initial_note || '', hot_level || 'WARM',
            leadStatus, branch_id || null, assignedTo, branch_id ? req.user.id : null,
            req.user.id, appointment_date || '', notes || ''
        );

        const newBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);
        logLeadEvent(newBooking.id, req.user.id, req.user.username, 'created', `Tạo lead: ${full_name} - ${phoneClean}`, '', leadStatus);

        if (branch_id) {
            const branchName = db.prepare('SELECT name FROM branches WHERE id = ?').get(branch_id)?.name || '';
            logLeadEvent(newBooking.id, req.user.id, req.user.username, 'assigned', `Phân về ${branchName}`, '', branchName);
        }

        logActivity(req.user.id, req.user.username, req.user.role, 'lead_created', `${full_name} - ${phoneClean}`, req.ip);
        res.status(201).json({ message: 'Tạo lead thành công!', booking: newBooking });
    } catch (error) {
        console.error('Error creating lead:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// Force create lead (bypass duplicate check)
app.post('/api/bookings/manual/force', auth, requireRole('admin', 'truc_page'), (req, res) => {
    try {
        const { full_name, phone, service, interest_service, source, funnel_name, hot_level, initial_note, branch_id, gender, birth_year, area, notes, appointment_date } = req.body;
        if (!full_name || !phone) return res.status(400).json({ error: 'Vui lòng nhập họ tên và SĐT' });

        const phoneClean = phone.replace(/\s/g, '');
        let assignedTo = null;
        let leadStatus = 'NEW';
        if (branch_id) {
            const telesale = db.prepare("SELECT id FROM users WHERE branch_id = ? AND role = 'telesale' AND active = 1 LIMIT 1").get(branch_id);
            assignedTo = telesale ? telesale.id : null;
            leadStatus = 'ASSIGNED';
        }

        const result = db.prepare(`
            INSERT INTO bookings (full_name, phone, gender, birth_year, area, source, funnel_name, interest_service, service, initial_note, hot_level, status, branch_id, assigned_to, assigned_by, assigned_at, created_by, appointment_date, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${branch_id ? "datetime('now','localtime')" : 'NULL'}, ?, ?, ?)
        `).run(
            full_name.trim(), phoneClean, gender || '', birth_year || null, area || '',
            source || 'OTHER', funnel_name || '', interest_service || '', service || interest_service || '',
            initial_note || '', hot_level || 'WARM', leadStatus, branch_id || null, assignedTo, branch_id ? req.user.id : null,
            req.user.id, appointment_date || '', notes || ''
        );

        const newBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);
        logLeadEvent(newBooking.id, req.user.id, req.user.username, 'created', 'Tạo lead (bỏ qua trùng)', '', leadStatus);
        logActivity(req.user.id, req.user.username, req.user.role, 'lead_created_force', `${full_name} - ${phoneClean}`, req.ip);
        res.status(201).json({ message: 'Tạo lead thành công!', booking: newBooking });
    } catch (error) {
        console.error('Error creating lead:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// Update lead
app.patch('/api/bookings/:id', auth, (req, res) => {
    try {
        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Không tìm thấy lead' });

        const allowedFields = ['full_name', 'phone', 'gender', 'birth_year', 'area', 'source', 'funnel_name', 'interest_service', 'service', 'initial_note', 'hot_level', 'status', 'notes', 'lost_reason', 'appointment_date'];
        const updates = [];
        const values = [];

        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) {
                updates.push(`${field} = ?`);
                values.push(req.body[field]);
                if (field === 'status' && req.body[field] !== booking.status) {
                    logLeadEvent(booking.id, req.user.id, req.user.username, 'status_changed', `Đổi trạng thái`, booking.status, req.body[field]);
                }
            }
        });

        if (updates.length === 0) return res.status(400).json({ error: 'Không có dữ liệu cập nhật' });

        updates.push("updated_at = datetime('now','localtime')");
        values.push(req.params.id);
        db.prepare(`UPDATE bookings SET ${updates.join(', ')} WHERE id = ?`).run(...values);

        logActivity(req.user.id, req.user.username, req.user.role, 'lead_updated', `Cập nhật lead #${req.params.id}`, req.ip);
        const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
        res.json({ message: 'Cập nhật thành công', booking: updated });
    } catch (error) {
        console.error('Update error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// Delete lead
app.delete('/api/bookings/:id', auth, requireRole('admin', 'truc_page'), (req, res) => {
    try {
        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Không tìm thấy lead' });
        db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
        logActivity(req.user.id, req.user.username, req.user.role, 'lead_deleted', `Xóa lead #${req.params.id} - ${booking.full_name}`, req.ip);
        res.json({ message: 'Đã xóa thành công' });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== STAFF LEAD ENTRY ====================

// Create lead from staff/telesale (auto-assign to their branch)
app.post('/api/bookings/staff', auth, requireRole('telesale'), (req, res) => {
    try {
        const { full_name, phone, zalo_id, interest_service, source, notes } = req.body;

        if (!full_name) {
            return res.status(400).json({ error: 'Vui lòng nhập họ tên' });
        }

        // Must have at least phone or zalo_id
        if (!phone && !zalo_id) {
            return res.status(400).json({ error: 'Vui lòng nhập SĐT hoặc Zalo' });
        }

        let phoneClean = '';
        if (phone) {
            phoneClean = phone.replace(/\s/g, '');
            const phoneRegex = /^(0|\+84)[0-9]{9,10}$/;
            if (!phoneRegex.test(phoneClean)) {
                return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
            }
        }

        const zaloClean = (zalo_id || '').trim();

        // Duplicate detection by phone (only if phone provided)
        if (phoneClean) {
            const existing = db.prepare(`
                SELECT b.*, br.name as branch_name FROM bookings b
                LEFT JOIN branches br ON b.branch_id = br.id
                WHERE b.phone = ? ORDER BY b.created_at DESC LIMIT 1
            `).get(phoneClean);
            if (existing) {
                return res.status(409).json({
                    error: 'duplicate',
                    message: `Khách này đã tồn tại ở ${existing.branch_name || 'chưa phân CN'}, trạng thái ${existing.status}`,
                    existing_lead: existing
                });
            }
        }

        // Duplicate detection by zalo_id (only if zalo provided and no phone)
        if (!phoneClean && zaloClean) {
            const existingZalo = db.prepare(`
                SELECT b.*, br.name as branch_name FROM bookings b
                LEFT JOIN branches br ON b.branch_id = br.id
                WHERE b.zalo_id = ? AND b.zalo_id != '' ORDER BY b.created_at DESC LIMIT 1
            `).get(zaloClean);
            if (existingZalo) {
                return res.status(409).json({
                    error: 'duplicate',
                    message: `Khách Zalo này đã tồn tại ở ${existingZalo.branch_name || 'chưa phân CN'}, trạng thái ${existingZalo.status}`,
                    existing_lead: existingZalo
                });
            }
        }

        const branchId = req.user.branchId;
        if (!branchId) {
            return res.status(400).json({ error: 'Bạn chưa được gán chi nhánh' });
        }

        // Use phone or generate placeholder for Zalo-only
        const phoneForDB = phoneClean || `ZALO_${zaloClean}`;

        const result = db.prepare(`
            INSERT INTO bookings (full_name, phone, zalo_id, interest_service, source, notes, status, branch_id, assigned_to, assigned_by, assigned_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, 'ASSIGNED', ?, ?, ?, datetime('now','localtime'), ?)
        `).run(
            full_name.trim(), phoneForDB, zaloClean,
            interest_service || '', source || 'OTHER', notes || '',
            branchId, req.user.id, req.user.id, req.user.id
        );

        const newBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);
        logLeadEvent(newBooking.id, req.user.id, req.user.username, 'created', `Tạo KH: ${full_name}${zaloClean ? ' (Zalo: ' + zaloClean + ')' : ''}`, '', 'ASSIGNED');
        logActivity(req.user.id, req.user.username, req.user.role, 'lead_created_staff', `${full_name} - ${phoneForDB}${zaloClean ? ' - Zalo: ' + zaloClean : ''}`, req.ip);

        res.status(201).json({ message: 'Đã nhập khách hàng!', booking: newBooking });
    } catch (error) {
        console.error('Error creating staff lead:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== LEAD ASSIGNMENT ====================

app.post('/api/bookings/:id/assign', auth, (req, res) => {
    try {
        const { branch_id } = req.body;
        if (!branch_id) return res.status(400).json({ error: 'Vui lòng chọn chi nhánh' });

        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Không tìm thấy lead' });

        const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(branch_id);
        if (!branch) return res.status(404).json({ error: 'Chi nhánh không tồn tại' });

        // Auto-find telesales for this branch
        const telesale = db.prepare("SELECT id FROM users WHERE branch_id = ? AND role = 'telesale' AND active = 1 LIMIT 1").get(branch_id);

        const oldStatus = booking.status;
        const newStatus = (oldStatus === 'NEW') ? 'ASSIGNED' : oldStatus;

        db.prepare(`
            UPDATE bookings SET branch_id = ?, assigned_to = ?, assigned_by = ?, assigned_at = datetime('now','localtime'), status = ?, updated_at = datetime('now','localtime')
            WHERE id = ?
        `).run(branch_id, telesale?.id || null, req.user.id, newStatus, req.params.id);

        logLeadEvent(booking.id, req.user.id, req.user.username, 'assigned', `Phân về ${branch.name}`, booking.branch_id ? `CN ${booking.branch_id}` : '', branch.name);
        if (oldStatus !== newStatus) {
            logLeadEvent(booking.id, req.user.id, req.user.username, 'status_changed', 'Auto: phân chi nhánh', oldStatus, newStatus);
        }
        logActivity(req.user.id, req.user.username, req.user.role, 'lead_assigned', `Lead #${req.params.id} (${booking.full_name}) → ${branch.name}`, req.ip);

        const updated = db.prepare(`
            SELECT b.*, br.name as branch_name, ua.display_name as assigned_to_name
            FROM bookings b LEFT JOIN branches br ON b.branch_id = br.id LEFT JOIN users ua ON b.assigned_to = ua.id
            WHERE b.id = ?
        `).get(req.params.id);

        res.json({ message: `Đã phân về ${branch.name}`, booking: updated });
    } catch (error) {
        console.error('Assignment error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== CALL TRACKING ====================

app.post('/api/bookings/:id/calls', auth, (req, res) => {
    try {
        const { outcome, notes, next_call_at, care_reminder_at, appointment_at } = req.body;
        if (!outcome) return res.status(400).json({ error: 'Vui lòng chọn kết quả gọi' });

        const validOutcomes = ['NO_ANSWER', 'WRONG_NUMBER', 'NOT_INTERESTED', 'CALL_BACK_LATER', 'CARING', 'CONSULTED', 'APPOINTMENT_BOOKED', 'ARRIVED', 'CLOSED_FIRST_REVENUE', 'LOST'];
        if (!validOutcomes.includes(outcome)) return res.status(400).json({ error: 'Kết quả gọi không hợp lệ' });

        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Không tìm thấy lead' });

        if (outcome === 'APPOINTMENT_BOOKED' && !appointment_at) {
            return res.status(400).json({ error: 'Vui lòng chọn ngày hẹn' });
        }

        // Auto-calculate call number
        const lastCall = db.prepare('SELECT MAX(call_number) as max_num FROM call_logs WHERE booking_id = ?').get(req.params.id);
        const callNumber = (lastCall.max_num || 0) + 1;

        db.prepare(`
            INSERT INTO call_logs (booking_id, user_id, username, call_number, outcome, notes, next_call_at, care_reminder_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(req.params.id, req.user.id, req.user.username, callNumber, outcome, notes || '', next_call_at || null, care_reminder_at || null);

        // Auto-update lead fields
        const leadUpdates = {
            called_count: callNumber,
            last_called_at: "datetime('now','localtime')",
            last_call_outcome: outcome,
            updated_at: "datetime('now','localtime')"
        };

        // Status transitions based on outcome — prevent regression
        const oldStatus = booking.status;
        let newStatus = oldStatus;
        const outcomeToStatus = {
            'NO_ANSWER': 'CALLED',
            'WRONG_NUMBER': 'LOST',
            'NOT_INTERESTED': 'LOST',
            'CALL_BACK_LATER': 'FOLLOW_UP',
            'CARING': 'FOLLOW_UP',
            'CONSULTED': 'CALLED',
            'APPOINTMENT_BOOKED': 'APPOINTED',
            'ARRIVED': 'ARRIVED',
            'CLOSED_FIRST_REVENUE': 'WON',
            'LOST': 'LOST'
        };
        const STATUS_RANK = { NEW: 0, ASSIGNED: 1, CALLED: 2, FOLLOW_UP: 3, APPOINTED: 4, ARRIVED: 5, WON: 6, LOST: -1 };
        const targetStatus = outcomeToStatus[outcome];
        if (targetStatus) {
            const currentRank = STATUS_RANK[oldStatus] || 0;
            const targetRank = STATUS_RANK[targetStatus];
            // Only transition if the target is higher (or LOST which is always allowed)
            if (targetRank === -1 || targetRank >= currentRank) {
                newStatus = targetStatus;
            }
        }

        let sql = `UPDATE bookings SET called_count = ?, last_called_at = datetime('now','localtime'), last_call_outcome = ?, status = ?, updated_at = datetime('now','localtime')`;
        const sqlParams = [callNumber, outcome, newStatus];

        if (next_call_at) { sql += ', callback_at = ?'; sqlParams.push(next_call_at); }
        if (care_reminder_at) { sql += ', care_reminder_at = ?'; sqlParams.push(care_reminder_at); }
        if (appointment_at) { sql += ', appointment_at = ?'; sqlParams.push(appointment_at); }
        if (outcome === 'WRONG_NUMBER' || outcome === 'NOT_INTERESTED' || outcome === 'LOST') {
            sql += ', lost_reason = ?';
            sqlParams.push(outcome === 'WRONG_NUMBER' ? 'Sai số' : outcome === 'NOT_INTERESTED' ? 'Không có nhu cầu' : (notes || 'Mất khách'));
        }

        sql += ' WHERE id = ?';
        sqlParams.push(req.params.id);
        db.prepare(sql).run(...sqlParams);

        if (oldStatus !== newStatus) {
            logLeadEvent(booking.id, req.user.id, req.user.username, 'status_changed', `Cuộc gọi #${callNumber}: ${outcome}`, oldStatus, newStatus);
        }
        logLeadEvent(booking.id, req.user.id, req.user.username, 'call_logged', `Gọi lần ${callNumber}: ${outcome}`, '', notes || '');
        logActivity(req.user.id, req.user.username, req.user.role, 'call_logged', `Gọi lần ${callNumber}: ${booking.full_name} - ${outcome}`, req.ip);

        const calls = db.prepare('SELECT * FROM call_logs WHERE booking_id = ? ORDER BY call_number DESC').all(req.params.id);
        const updatedBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);

        res.status(201).json({ message: `Đã ghi cuộc gọi lần ${callNumber}`, calls, booking: updatedBooking });
    } catch (error) {
        console.error('Error logging call:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

app.get('/api/bookings/:id/calls', auth, (req, res) => {
    try {
        const calls = db.prepare('SELECT * FROM call_logs WHERE booking_id = ? ORDER BY call_number DESC').all(req.params.id);
        res.json({ calls });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== ARRIVED ====================

app.post('/api/bookings/:id/arrived', auth, (req, res) => {
    try {
        const { first_service_name } = req.body;
        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Không tìm thấy lead' });

        const oldStatus = booking.status;
        db.prepare(`
            UPDATE bookings SET status = 'ARRIVED', arrived_at = datetime('now','localtime'), first_service_name = ?, updated_at = datetime('now','localtime')
            WHERE id = ?
        `).run(first_service_name || '', req.params.id);

        logLeadEvent(booking.id, req.user.id, req.user.username, 'status_changed', 'Khách đã đến', oldStatus, 'ARRIVED');
        logActivity(req.user.id, req.user.username, req.user.role, 'lead_arrived', `Khách đến: ${booking.full_name}`, req.ip);

        const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
        res.json({ message: 'Đã cập nhật khách đến', booking: updated });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== REVENUE ====================

app.post('/api/bookings/:id/revenue', auth, (req, res) => {
    try {
        const { amount, service_name, notes } = req.body;
        if (!amount || amount <= 0) return res.status(400).json({ error: 'Số tiền không hợp lệ' });

        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Không tìm thấy lead' });

        db.prepare(`
            INSERT INTO revenues (booking_id, branch_id, telesales_id, amount, service_name, notes, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(req.params.id, booking.branch_id, booking.assigned_to, amount, service_name || '', notes || '', req.user.id);

        // Auto-set status to WON and update first_revenue
        const oldStatus = booking.status;
        db.prepare(`
            UPDATE bookings SET status = 'WON', first_revenue = ?, first_service_name = CASE WHEN first_service_name = '' THEN ? ELSE first_service_name END, updated_at = datetime('now','localtime')
            WHERE id = ?
        `).run(amount, service_name || '', req.params.id);

        logLeadEvent(booking.id, req.user.id, req.user.username, 'revenue_added', `Doanh thu: ${Number(amount).toLocaleString('vi-VN')}đ`, oldStatus, 'WON');
        logActivity(req.user.id, req.user.username, req.user.role, 'revenue_recorded', `DT #${req.params.id}: ${Number(amount).toLocaleString('vi-VN')}đ`, req.ip);

        const totalRevenue = db.prepare('SELECT SUM(amount) as total FROM revenues WHERE booking_id = ?').get(req.params.id).total;
        res.status(201).json({ message: 'Đã ghi doanh thu', total_revenue: totalRevenue });
    } catch (error) {
        console.error('Revenue error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

app.get('/api/bookings/:id/revenue', auth, (req, res) => {
    try {
        const revenues = db.prepare(`
            SELECT r.*, u.display_name as created_by_name
            FROM revenues r LEFT JOIN users u ON r.created_by = u.id
            WHERE r.booking_id = ? ORDER BY r.created_at DESC
        `).all(req.params.id);
        res.json(revenues);
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== LEAD EVENTS ====================

app.get('/api/bookings/:id/events', auth, (req, res) => {
    try {
        const events = db.prepare(`
            SELECT le.*, u.display_name as user_display_name
            FROM lead_events le LEFT JOIN users u ON le.user_id = u.id
            WHERE le.booking_id = ? ORDER BY le.created_at DESC
        `).all(req.params.id);
        res.json({ events });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== REMINDERS ====================

app.get('/api/reminders', auth, (req, res) => {
    try {
        const today = vnDateStr(new Date());
        let scopeWhere = '';
        const params = [today, today];
        if (req.user.role === 'telesale' && req.user.branchId) {
            scopeWhere = ' AND b.branch_id = ?';
            params.push(req.user.branchId);
        }

        const callbacks = db.prepare(`
            SELECT b.*, br.name as branch_name FROM bookings b
            LEFT JOIN branches br ON b.branch_id = br.id
            WHERE b.callback_at IS NOT NULL AND DATE(b.callback_at) <= ? AND b.status NOT IN ('WON','LOST')${scopeWhere}
            ORDER BY b.callback_at ASC
        `).all(params[0], ...(params.length > 2 ? [params[2]] : []));

        const careReminders = db.prepare(`
            SELECT b.*, br.name as branch_name FROM bookings b
            LEFT JOIN branches br ON b.branch_id = br.id
            WHERE b.care_reminder_at IS NOT NULL AND DATE(b.care_reminder_at) <= ? AND b.status NOT IN ('WON','LOST')${scopeWhere}
            ORDER BY b.care_reminder_at ASC
        `).all(params[1], ...(params.length > 2 ? [params[2]] : []));

        res.json({ callbacks, care_reminders: careReminders });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== USER MANAGEMENT ====================

app.get('/api/users', auth, requireRole('admin'), (req, res) => {
    const users = db.prepare(`
        SELECT u.id, u.username, u.display_name, u.role, u.active, u.created_at, u.last_login, u.branch_id, b.name as branch_name
        FROM users u LEFT JOIN branches b ON u.branch_id = b.id ORDER BY u.created_at DESC
    `).all();
    res.json(users);
});

app.post('/api/users', auth, requireRole('admin'), (req, res) => {
    try {
        const { username, password, display_name, role, branch_id } = req.body;
        if (!username || !password || !display_name || !role) return res.status(400).json({ error: 'Vui lòng điền đầy đủ thông tin' });

        const validRoles = ['admin', 'truc_page', 'telesale'];
        if (!validRoles.includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });

        const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (existing) return res.status(400).json({ error: 'Username đã tồn tại' });

        const { hash, salt } = hashPassword(password);
        db.prepare('INSERT INTO users (username, password_hash, salt, display_name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(username, hash, salt, display_name, role, branch_id || null);
        logActivity(req.user.id, req.user.username, req.user.role, 'user_created', `Tạo user: ${username} (${role})`, req.ip);
        res.status(201).json({ message: 'Tạo user thành công' });
    } catch (error) {
        console.error('Create user error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

app.patch('/api/users/:id', auth, requireRole('admin'), (req, res) => {
    try {
        const { display_name, role, active, password, branch_id } = req.body;
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
        if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });

        if (display_name) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name, req.params.id);
        if (role) {
            const validRoles = ['admin', 'truc_page', 'telesale'];
            if (!validRoles.includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
            db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
        }
        if (branch_id !== undefined) db.prepare('UPDATE users SET branch_id = ? WHERE id = ?').run(branch_id || null, req.params.id);
        if (active !== undefined) {
            db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
            if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
        }
        if (password) {
            const { hash, salt } = hashPassword(password);
            db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, req.params.id);
        }

        logActivity(req.user.id, req.user.username, req.user.role, 'user_updated', `Cập nhật user: ${user.username}`, req.ip);
        res.json({ message: 'Cập nhật thành công' });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

app.delete('/api/users/:id', auth, requireRole('admin'), (req, res) => {
    try {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
        if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });
        if (user.id === req.user.id) return res.status(400).json({ error: 'Không thể tự xóa tài khoản của mình' });
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
        logActivity(req.user.id, req.user.username, req.user.role, 'user_deleted', `Xóa user: ${user.username}`, req.ip);
        res.json({ message: 'Đã xóa user' });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== ACTIVITY LOGS ====================

app.get('/api/logs', auth, requireRole('admin'), (req, res) => {
    try {
        const { limit = 100, offset = 0 } = req.query;
        const logs = db.prepare('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(Number(limit), Number(offset));
        const total = db.prepare('SELECT COUNT(*) as count FROM activity_logs').get().count;
        res.json({ logs, total });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== BRANCHES ====================

app.get('/api/branches', auth, (req, res) => {
    const branches = db.prepare('SELECT * FROM branches WHERE active = 1 ORDER BY id').all();
    res.json(branches);
});

app.post('/api/branches', auth, requireRole('admin'), (req, res) => {
    try {
        const { name, code, address, phone } = req.body;
        if (!name) return res.status(400).json({ error: 'Tên chi nhánh là bắt buộc' });
        db.prepare('INSERT INTO branches (name, code, address, phone) VALUES (?, ?, ?, ?)').run(name.trim(), code || '', address || '', phone || '');
        logActivity(req.user.id, req.user.username, req.user.role, 'branch_created', `Tạo chi nhánh: ${name}`, req.ip);
        res.status(201).json({ message: 'Tạo chi nhánh thành công' });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

app.patch('/api/branches/:id', auth, requireRole('admin'), (req, res) => {
    try {
        const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id);
        if (!branch) return res.status(404).json({ error: 'Không tìm thấy chi nhánh' });

        const { name, code, address, phone, active } = req.body;
        if (name) db.prepare('UPDATE branches SET name = ? WHERE id = ?').run(name, req.params.id);
        if (code !== undefined) db.prepare('UPDATE branches SET code = ? WHERE id = ?').run(code, req.params.id);
        if (address !== undefined) db.prepare('UPDATE branches SET address = ? WHERE id = ?').run(address, req.params.id);
        if (phone !== undefined) db.prepare('UPDATE branches SET phone = ? WHERE id = ?').run(phone, req.params.id);
        if (active !== undefined) db.prepare('UPDATE branches SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);

        logActivity(req.user.id, req.user.username, req.user.role, 'branch_updated', `Cập nhật CN: ${branch.name}`, req.ip);
        res.json({ message: 'Cập nhật thành công' });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== REPORTS ====================

app.post('/api/reports/truc-page', auth, (req, res) => {
    try {
        const { contacts_count, report_date, notes } = req.body;
        if (!contacts_count || contacts_count < 0) return res.status(400).json({ error: 'Vui lòng nhập số liên hệ hợp lệ' });

        const date = report_date || vnDateStr(new Date());
        const existing = db.prepare('SELECT id FROM daily_reports WHERE report_date = ? AND user_id = ?').get(date, req.user.id);
        if (existing) {
            db.prepare("UPDATE daily_reports SET contacts_count = ?, notes = ?, created_at = datetime('now','localtime') WHERE id = ?").run(contacts_count, notes || '', existing.id);
        } else {
            db.prepare('INSERT INTO daily_reports (report_date, user_id, username, role, contacts_count, notes) VALUES (?, ?, ?, ?, ?, ?)').run(date, req.user.id, req.user.username, req.user.role, contacts_count, notes || '');
        }
        logActivity(req.user.id, req.user.username, req.user.role, 'report_submitted', `Báo cáo: ${contacts_count} liên hệ ngày ${date}`, req.ip);
        res.json({ message: 'Đã ghi báo cáo!' });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== ADMIN DASHBOARD ====================

app.get('/api/dashboard/admin', auth, requireRole('admin'), (req, res) => {
    try {
        const today = vnDateStr(new Date());
        const { from, to } = req.query;
        const dateFilter = (from && to) ? ` AND DATE(created_at) BETWEEN '${from}' AND '${to}'` : '';
        const revDateFilter = (from && to) ? ` AND DATE(r.created_at) BETWEEN '${from}' AND '${to}'` : '';
        const bkDateFilter = (from && to) ? ` AND DATE(b.created_at) BETWEEN '${from}' AND '${to}'` : '';

        // Overview KPIs
        const totalLeads = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE 1=1${dateFilter}`).get().c;
        const leadsToday = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE DATE(created_at) = ?").get(today).c;
        const totalCalled = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE called_count > 0${dateFilter}`).get().c;
        const totalAppointed = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status IN ('APPOINTED','ARRIVED','WON')${dateFilter}`).get().c;
        const totalArrived = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status IN ('ARRIVED','WON')${dateFilter}`).get().c;
        const totalWon = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status = 'WON'${dateFilter}`).get().c;
        const totalLost = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status = 'LOST'${dateFilter}`).get().c;
        const totalRevenue = db.prepare(`SELECT COALESCE(SUM(amount), 0) as t FROM revenues r WHERE 1=1${revDateFilter.replace('r.', '')}`).get().t;
        const revenueToday = db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM revenues WHERE DATE(created_at) = ?").get(today).t;

        // Rates
        const callRate = totalLeads > 0 ? ((totalCalled / totalLeads) * 100).toFixed(1) : '0.0';
        const appointmentRate = totalLeads > 0 ? ((totalAppointed / totalLeads) * 100).toFixed(1) : '0.0';
        const arrivalRate = totalAppointed > 0 ? ((totalArrived / totalAppointed) * 100).toFixed(1) : '0.0';
        const avgRevenuePerArrival = totalArrived > 0 ? Math.round(totalRevenue / totalArrived) : 0;

        // Branch comparison
        const branchStats = db.prepare(`
            SELECT br.id, br.name, br.code,
                (SELECT COUNT(*) FROM bookings b WHERE b.branch_id = br.id${bkDateFilter}) as total_leads,
                (SELECT COUNT(*) FROM bookings b WHERE b.branch_id = br.id AND b.called_count > 0${bkDateFilter}) as called,
                (SELECT COUNT(*) FROM bookings b WHERE b.branch_id = br.id AND b.status IN ('APPOINTED','ARRIVED','WON')${bkDateFilter}) as appointed,
                (SELECT COUNT(*) FROM bookings b WHERE b.branch_id = br.id AND b.status IN ('ARRIVED','WON')${bkDateFilter}) as arrived,
                (SELECT COUNT(*) FROM bookings b WHERE b.branch_id = br.id AND b.status = 'WON'${bkDateFilter}) as won,
                COALESCE((SELECT SUM(r.amount) FROM revenues r WHERE r.branch_id = br.id${revDateFilter}), 0) as revenue
            FROM branches br WHERE br.active = 1 ORDER BY br.id
        `).all();

        // Staff comparison
        const staffStats = db.prepare(`
            SELECT u.id, u.display_name, u.username, br.name as branch_name, br.code as branch_code,
                (SELECT COUNT(*) FROM bookings b WHERE b.assigned_to = u.id${bkDateFilter}) as total_leads,
                (SELECT COUNT(*) FROM bookings b WHERE b.assigned_to = u.id AND b.called_count > 0${bkDateFilter}) as called,
                (SELECT COUNT(*) FROM bookings b WHERE b.assigned_to = u.id AND b.status IN ('APPOINTED','ARRIVED','WON')${bkDateFilter}) as appointed,
                (SELECT COUNT(*) FROM bookings b WHERE b.assigned_to = u.id AND b.status IN ('ARRIVED','WON')${bkDateFilter}) as arrived,
                (SELECT COUNT(*) FROM bookings b WHERE b.assigned_to = u.id AND b.status = 'WON'${bkDateFilter}) as won,
                COALESCE((SELECT SUM(r.amount) FROM revenues r WHERE r.telesales_id = u.id${revDateFilter}), 0) as revenue
            FROM users u LEFT JOIN branches br ON u.branch_id = br.id
            WHERE u.role = 'telesale' AND u.active = 1 ORDER BY revenue DESC
        `).all();

        // Source breakdown
        const sourceStats = db.prepare(`
            SELECT source, COUNT(*) as count,
                SUM(CASE WHEN status IN ('ARRIVED','WON') THEN 1 ELSE 0 END) as arrived,
                COALESCE(SUM(first_revenue), 0) as revenue
            FROM bookings WHERE 1=1${dateFilter} GROUP BY source ORDER BY count DESC
        `).all();

        // Funnel breakdown
        const funnelStats = db.prepare(`
            SELECT COALESCE(NULLIF(funnel_name, ''), 'Chưa xác định') as funnel_name, COUNT(*) as count,
                SUM(CASE WHEN status IN ('APPOINTED','ARRIVED','WON') THEN 1 ELSE 0 END) as appointed,
                SUM(CASE WHEN status IN ('ARRIVED','WON') THEN 1 ELSE 0 END) as arrived,
                COALESCE(SUM(first_revenue), 0) as revenue
            FROM bookings WHERE 1=1${dateFilter} GROUP BY funnel_name ORDER BY revenue DESC
        `).all();

        // Page operator KPIs
        const pageDataToday = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE DATE(created_at) = ?").get(today).c;
        const pageUnassigned = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE branch_id IS NULL").get().c;

        res.json({
            overview: {
                total_leads: totalLeads, leads_today: leadsToday,
                total_called: totalCalled, total_appointed: totalAppointed,
                total_arrived: totalArrived, total_won: totalWon, total_lost: totalLost,
                total_revenue: totalRevenue, revenue_today: revenueToday,
                call_rate: callRate, appointment_rate: appointmentRate,
                arrival_rate: arrivalRate, avg_revenue_per_arrival: avgRevenuePerArrival
            },
            branches: branchStats,
            staff: staffStats,
            sources: sourceStats,
            funnels: funnelStats,
            page_operator: { data_today: pageDataToday, unassigned: pageUnassigned }
        });
    } catch (error) {
        console.error('Admin dashboard error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== CSV EXPORT ====================

app.get('/api/bookings/export', auth, requireRole('admin'), (req, res) => {
    try {
        const { from, to, status, branch_id } = req.query;
        let sql = `SELECT b.*, br.name as branch_name, br.code as branch_code,
            u1.display_name as assigned_to_name, u2.display_name as created_by_name
            FROM bookings b
            LEFT JOIN branches br ON b.branch_id = br.id
            LEFT JOIN users u1 ON b.assigned_to = u1.id
            LEFT JOIN users u2 ON b.created_by = u2.id WHERE 1=1`;
        const params = [];
        if (from && to) { sql += ' AND DATE(b.created_at) BETWEEN ? AND ?'; params.push(from, to); }
        if (status) { sql += ' AND b.status = ?'; params.push(status); }
        if (branch_id) { sql += ' AND b.branch_id = ?'; params.push(branch_id); }
        sql += ' ORDER BY b.created_at DESC';
        const rows = db.prepare(sql).all(...params);

        const STATUS_MAP = { NEW:'Mới', ASSIGNED:'Đã phân', CALLED:'Đã gọi', FOLLOW_UP:'Chăm sóc', APPOINTED:'Có hẹn', ARRIVED:'Đã đến', WON:'Có doanh thu', LOST:'Mất' };
        const HOT_MAP = { HOT:'Nóng', WARM:'Ấm', COLD:'Lạnh' };

        const headers = ['STT','Họ tên','SĐT','Giới tính','Năm sinh','Khu vực','Nguồn','Phễu','DV quan tâm','Ghi chú ban đầu','Mức độ','Trạng thái','Chi nhánh','Telesales','Số lần gọi','Kết quả gọi gần nhất','Ngày hẹn','Ngày đến','DV lần đầu','Doanh thu lần đầu','Lý do mất','Ngày tạo'];
        const csvRows = [headers.join(',')];
        rows.forEach((r, i) => {
            const vals = [
                i + 1, `"${(r.full_name||'').replace(/"/g,'""')}"`, r.phone, r.gender || '',
                r.birth_year || '', `"${(r.area||'').replace(/"/g,'""')}"`, r.source || '',
                `"${(r.funnel_name||'').replace(/"/g,'""')}"`, `"${(r.interest_service||'').replace(/"/g,'""')}"`,
                `"${(r.initial_note||'').replace(/"/g,'""')}"`, HOT_MAP[r.hot_level] || r.hot_level || '',
                STATUS_MAP[r.status] || r.status, r.branch_code || r.branch_name || '',
                `"${(r.assigned_to_name||'').replace(/"/g,'""')}"`, r.called_count || 0,
                r.last_call_outcome || '', r.appointment_at || '', r.arrived_at || '',
                `"${(r.first_service_name||'').replace(/"/g,'""')}"`, r.first_revenue || 0,
                `"${(r.lost_reason||'').replace(/"/g,'""')}"`, r.created_at || ''
            ];
            csvRows.push(vals.join(','));
        });

        const csvContent = '\uFEFF' + csvRows.join('\n');
        const dateLabel = (from && to) ? `${from}_${to}` : vnDateStr(new Date());
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="leads_${dateLabel}.csv"`);
        res.send(csvContent);
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra khi xuất file' });
    }
});

// ==================== APPOINTMENTS CALENDAR ====================

app.get('/api/appointments', auth, (req, res) => {
    try {
        const { from, to, branch_id } = req.query;
        let sql = `SELECT b.id, b.full_name, b.phone, b.interest_service, b.appointment_at, b.status, b.hot_level,
            br.name as branch_name, br.code as branch_code,
            u.display_name as telesales_name
            FROM bookings b
            LEFT JOIN branches br ON b.branch_id = br.id
            LEFT JOIN users u ON b.assigned_to = u.id
            WHERE b.appointment_at IS NOT NULL AND b.appointment_at != ''`;
        const params = [];

        // Date filter on appointment_at
        if (from && to) {
            sql += ' AND DATE(b.appointment_at) BETWEEN ? AND ?';
            params.push(from, to);
        }

        // Branch isolation for telesale
        if (req.user.role === 'telesale') {
            sql += ' AND b.branch_id = ?';
            params.push(req.user.branchId);
        } else if (branch_id) {
            sql += ' AND b.branch_id = ?';
            params.push(branch_id);
        }

        sql += ' ORDER BY b.appointment_at ASC';
        const appointments = db.prepare(sql).all(...params);
        res.json({ appointments });
    } catch (error) {
        console.error('Appointments error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== REPORTS ====================

// Page operator report: data entered per day by service
app.get('/api/reports/page', auth, (req, res) => {
    try {
        const { from, to } = req.query;
        const today = vnDateStr(new Date());
        const dateFrom = from || today;
        const dateTo = to || today;

        // Group by service
        const byService = db.prepare(`
            SELECT interest_service as service_name, COUNT(*) as count,
                GROUP_CONCAT(full_name || '::' || phone, '||') as contacts
            FROM bookings
            WHERE DATE(created_at) BETWEEN ? AND ?
            GROUP BY interest_service ORDER BY count DESC
        `).all(dateFrom, dateTo);

        // Total
        const total = db.prepare(`
            SELECT COUNT(*) as total FROM bookings WHERE DATE(created_at) BETWEEN ? AND ?
        `).get(dateFrom, dateTo);

        // By branch
        const byBranch = db.prepare(`
            SELECT br.name as branch_name, br.code as branch_code, COUNT(*) as count
            FROM bookings b LEFT JOIN branches br ON b.branch_id = br.id
            WHERE DATE(b.created_at) BETWEEN ? AND ?
            GROUP BY b.branch_id ORDER BY count DESC
        `).all(dateFrom, dateTo);

        // Service detail per branch
        const branchServices = db.prepare(`
            SELECT br.name as branch_name, COALESCE(br.code,'') as branch_code,
                b.interest_service as service_name, COUNT(*) as count,
                GROUP_CONCAT(b.full_name || '::' || b.phone, '||') as contacts
            FROM bookings b LEFT JOIN branches br ON b.branch_id = br.id
            WHERE DATE(b.created_at) BETWEEN ? AND ?
            GROUP BY b.branch_id, b.interest_service ORDER BY br.name, count DESC
        `).all(dateFrom, dateTo);

        // Group services by branch
        const branchMap = {};
        for (const row of branchServices) {
            const key = row.branch_name || 'Chưa phân';
            if (!branchMap[key]) branchMap[key] = [];
            branchMap[key].push({ service_name: row.service_name, count: row.count, contacts: row.contacts });
        }
        byBranch.forEach(b => { b.services = branchMap[b.branch_name || 'Chưa phân'] || []; });

        res.json({ by_service: byService, total: total.total, by_branch: byBranch, from: dateFrom, to: dateTo });
    } catch (error) {
        console.error('Page report error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// Branch/telesale report: appointments, arrived, revenue by service + rates
app.get('/api/reports/branch', auth, (req, res) => {
    try {
        const { from, to } = req.query;
        const today = vnDateStr(new Date());
        const dateFrom = from || today;
        const dateTo = to || today;

        let branchFilter = '';
        const params = [dateFrom, dateTo];
        if (req.user.role === 'telesale' && req.user.branchId) {
            branchFilter = ' AND b.branch_id = ?';
            params.push(req.user.branchId);
        }

        // By service
        const byService = db.prepare(`
            SELECT COALESCE(NULLIF(b.interest_service, ''), 'Chưa xác định') as service_name,
                COUNT(*) as total_leads,
                SUM(CASE WHEN b.status IN ('APPOINTED','ARRIVED','WON') THEN 1 ELSE 0 END) as appointed,
                SUM(CASE WHEN b.status IN ('ARRIVED','WON') THEN 1 ELSE 0 END) as arrived,
                COALESCE(SUM(b.first_revenue), 0) as revenue
            FROM bookings b
            WHERE DATE(b.created_at) BETWEEN ? AND ?${branchFilter}
            GROUP BY service_name ORDER BY total_leads DESC
        `).all(...params);

        // Call stats
        const totalLeads = db.prepare(`SELECT COUNT(*) as c FROM bookings b WHERE DATE(b.created_at) BETWEEN ? AND ?${branchFilter}`).get(...params).c;
        const totalCalled = db.prepare(`SELECT COUNT(*) as c FROM bookings b WHERE b.called_count > 0 AND DATE(b.created_at) BETWEEN ? AND ?${branchFilter}`).get(...params).c;
        const totalAppointed = db.prepare(`SELECT COUNT(*) as c FROM bookings b WHERE b.status IN ('APPOINTED','ARRIVED','WON') AND DATE(b.created_at) BETWEEN ? AND ?${branchFilter}`).get(...params).c;
        const totalArrived = db.prepare(`SELECT COUNT(*) as c FROM bookings b WHERE b.status IN ('ARRIVED','WON') AND DATE(b.created_at) BETWEEN ? AND ?${branchFilter}`).get(...params).c;
        const totalRevenue = db.prepare(`SELECT COALESCE(SUM(b.first_revenue), 0) as t FROM bookings b WHERE DATE(b.created_at) BETWEEN ? AND ?${branchFilter}`).get(...params).t;
        const totalCalls = db.prepare(`SELECT COUNT(*) as c FROM call_logs cl JOIN bookings b ON cl.booking_id = b.id WHERE DATE(cl.call_time) BETWEEN ? AND ?${branchFilter.replace('b.branch_id', 'b.branch_id')}`).get(...params).c;

        const callRate = totalLeads > 0 ? ((totalCalled / totalLeads) * 100).toFixed(1) : '0.0';
        const appointRate = totalLeads > 0 ? ((totalAppointed / totalLeads) * 100).toFixed(1) : '0.0';
        const arrivalRate = totalAppointed > 0 ? ((totalArrived / totalAppointed) * 100).toFixed(1) : '0.0';

        // By funnel
        const byFunnel = db.prepare(`
            SELECT COALESCE(NULLIF(b.funnel_name, ''), 'Chưa xác định') as funnel_name,
                COUNT(*) as total_leads,
                SUM(CASE WHEN b.status IN ('APPOINTED','ARRIVED','WON') THEN 1 ELSE 0 END) as appointed,
                SUM(CASE WHEN b.status IN ('ARRIVED','WON') THEN 1 ELSE 0 END) as arrived,
                COALESCE(SUM(b.first_revenue), 0) as revenue
            FROM bookings b
            WHERE DATE(b.created_at) BETWEEN ? AND ?${branchFilter}
            GROUP BY funnel_name ORDER BY revenue DESC
        `).all(...params);

        res.json({
            by_service: byService,
            by_funnel: byFunnel,
            summary: { total_leads: totalLeads, total_called: totalCalled, total_appointed: totalAppointed, total_arrived: totalArrived, total_revenue: totalRevenue, total_calls: totalCalls, call_rate: callRate, appoint_rate: appointRate, arrival_rate: arrivalRate },
            from: dateFrom, to: dateTo
        });
    } catch (error) {
        console.error('Branch report error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== AUTO REMINDERS ====================

// Care after arrived: customers who came yesterday (9am next day)
app.get('/api/reminders/care-after-arrived', auth, (req, res) => {
    try {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yStr = vnDateStr(yesterday);

        let branchFilter = '';
        const params = [yStr];
        if (req.user.role === 'telesale' && req.user.branchId) {
            branchFilter = ' AND b.branch_id = ?';
            params.push(req.user.branchId);
        }

        const leads = db.prepare(`
            SELECT b.id, b.full_name, b.phone, b.interest_service, b.first_service_name, b.first_revenue,
                b.arrived_at, b.status, br.name as branch_name, br.code as branch_code,
                u.display_name as telesales_name
            FROM bookings b
            LEFT JOIN branches br ON b.branch_id = br.id
            LEFT JOIN users u ON b.assigned_to = u.id
            WHERE DATE(b.arrived_at) = ?${branchFilter}
            ORDER BY b.arrived_at DESC
        `).all(...params);

        res.json({ leads, date: yStr, type: 'care_after_arrived', reminder_time: '09:00' });
    } catch (error) {
        console.error('Care reminder error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// No-show yesterday: customers who had appointment yesterday but didn't arrive (10am next day)
app.get('/api/reminders/no-show-yesterday', auth, (req, res) => {
    try {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yStr = vnDateStr(yesterday);

        let branchFilter = '';
        const params = [yStr];
        if (req.user.role === 'telesale' && req.user.branchId) {
            branchFilter = ' AND b.branch_id = ?';
            params.push(req.user.branchId);
        }

        const leads = db.prepare(`
            SELECT b.id, b.full_name, b.phone, b.interest_service, b.appointment_at,
                b.status, br.name as branch_name, br.code as branch_code,
                u.display_name as telesales_name
            FROM bookings b
            LEFT JOIN branches br ON b.branch_id = br.id
            LEFT JOIN users u ON b.assigned_to = u.id
            WHERE DATE(b.appointment_at) = ? AND b.status NOT IN ('ARRIVED','WON')${branchFilter}
            ORDER BY b.appointment_at DESC
        `).all(...params);

        res.json({ leads, date: yStr, type: 'no_show_yesterday', reminder_time: '10:00' });
    } catch (error) {
        console.error('No-show reminder error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== LANDING PAGE ROUTES ====================

const landingDir = path.join(__dirname, 'public', 'landing');
if (fs.existsSync(landingDir)) {
    fs.readdirSync(landingDir).forEach(file => {
        if (file.endsWith('.html')) {
            const serviceId = file.replace('.html', '');
            app.get(`/${serviceId}`, (req, res) => {
                // Track page view
                const deviceType = /mobile|android|iphone/i.test(req.headers['user-agent'] || '') ? 'mobile' : 'desktop';
                db.prepare(`INSERT INTO page_views (service_id, ip_address, user_agent, referrer, utm_source, utm_medium, utm_campaign, utm_content, device_type)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                    serviceId, req.ip, req.headers['user-agent'] || '', req.headers.referer || '',
                    req.query.utm_source || '', req.query.utm_medium || '', req.query.utm_campaign || '', req.query.utm_content || '', deviceType
                );
                res.sendFile(path.join(landingDir, file));
            });
        }
    });
}

// ==================== PAGE ROUTES ====================

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', (req, res) => res.redirect('/login'));

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff.html')));
app.get('/staff/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff.html')));

app.get('/page', (req, res) => res.sendFile(path.join(__dirname, 'public', 'page.html')));
app.get('/page/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'page.html')));

// User guides
app.get('/huong-dan-admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'huong-dan-admin.html')));
app.get('/huong-dan-chi-nhanh', (req, res) => res.sendFile(path.join(__dirname, 'public', 'huong-dan-chi-nhanh.html')));
app.get('/huong-dan-truc-page', (req, res) => res.sendFile(path.join(__dirname, 'public', 'huong-dan-truc-page.html')));
app.get('/api-docs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'api-docs.html')));

// Legacy redirects
app.get('/branch', (req, res) => res.redirect('/admin'));
app.get('/branch/*', (req, res) => res.redirect('/admin'));
app.get('/direct-page', (req, res) => res.redirect('/page'));

// ==================== START SERVER ====================

app.listen(PORT, () => {
    console.log(`
  ══════════════════════════════════════════
       Hoàn Mỹ CRM Server — PORT ${PORT}
  ══════════════════════════════════════════

  → http://localhost:${PORT}/login
  → http://localhost:${PORT}/admin
  → http://localhost:${PORT}/staff
  → http://localhost:${PORT}/page

  ══════════════════════════════════════════
  `);
});
