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

// Helper: get Vietnam (UTC+7) date string 'YYYY-MM-DD' for a given Date object
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
    db.prepare(`
        INSERT INTO activity_logs (user_id, username, role, action, detail, ip_address)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, username, role, action, detail, ip || '');
}

// Auth middleware
function auth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ error: 'Chưa đăng nhập' });
    }

    const session = db.prepare(`
        SELECT s.*, u.id as user_id, u.username, u.display_name, u.role, u.active, u.branch_id
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.token = ? AND s.expires_at > datetime('now', 'localtime')
    `).get(token);

    if (!session || !session.active) {
        return res.status(401).json({ error: 'Phiên đăng nhập hết hạn' });
    }

    req.user = {
        id: session.user_id,
        username: session.username,
        displayName: session.display_name,
        role: session.role,
        branchId: session.branch_id
    };
    next();
}

// Role check middleware
function requireRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Không có quyền truy cập' });
        }
        next();
    };
}

// ==================== PUBLIC ROUTES ====================

// Static files
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));
app.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));
app.use('/manifest.json', express.static(path.join(__dirname, 'public', 'manifest.json')));
app.use('/sw.js', express.static(path.join(__dirname, 'public', 'sw.js')));



// Public booking endpoint
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

        const stmt = db.prepare(`
            INSERT INTO bookings (full_name, phone, service, appointment_date, notes)
            VALUES (?, ?, ?, ?, ?)
        `);

        const result = stmt.run(full_name.trim(), phone.trim(), service.trim(), appointment_date, notes || '');
        const newBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);

        logActivity(null, 'Khách hàng', 'guest', 'booking_created',
            `${full_name} - ${phone} - ${service}`, req.ip);

        res.status(201).json({
            message: 'Đặt lịch thành công!',
            booking: newBooking
        });
    } catch (error) {
        console.error('Error creating booking:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra, vui lòng thử lại' });
    }
});

// ==================== AUTH ROUTES ====================

// Login
app.post('/api/login', (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Vui lòng nhập username và mật khẩu' });
        }

        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (!user || !user.active) {
            return res.status(401).json({ error: 'Tài khoản không tồn tại hoặc đã bị khóa' });
        }

        if (!verifyPassword(password, user.password_hash, user.salt)) {
            logActivity(user.id, user.username, user.role, 'login_failed', 'Sai mật khẩu', req.ip);
            return res.status(401).json({ error: 'Mật khẩu không đúng' });
        }

        // Create session (expires in 24h)
        const token = generateToken();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        db.prepare(`INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)`).run(user.id, token, expiresAt);
        db.prepare(`UPDATE users SET last_login = datetime('now', 'localtime') WHERE id = ?`).run(user.id);

        logActivity(user.id, user.username, user.role, 'login', 'Đăng nhập thành công', req.ip);

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.display_name,
                role: user.role,
                branchId: user.branch_id
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// Logout
app.post('/api/logout', auth, (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    logActivity(req.user.id, req.user.username, req.user.role, 'logout', 'Đăng xuất', req.ip);
    res.json({ message: 'Đã đăng xuất' });
});

// Get current user
app.get('/api/me', auth, (req, res) => {
    res.json(req.user);
});

// ==================== PROTECTED BOOKING ROUTES ====================

// Get bookings (scoped by branch for telesales)
app.get('/api/bookings', auth, (req, res) => {
    try {
        const { service, status, date, search, sort, order, uncalled, branch_id } = req.query;

        let query = `SELECT b.*,
            br.name as branch_name,
            ua.display_name as assigned_to_name,
            (SELECT COUNT(*) FROM call_logs cl WHERE cl.booking_id = b.id) as call_count,
            (SELECT MAX(cl.call_time) FROM call_logs cl WHERE cl.booking_id = b.id) as last_call_time,
            (SELECT SUM(r.amount) FROM revenues r WHERE r.booking_id = b.id) as total_revenue
            FROM bookings b
            LEFT JOIN branches br ON b.branch_id = br.id
            LEFT JOIN users ua ON b.assigned_to = ua.id
            WHERE 1=1`;
        const params = [];

        // Scope for telesales: only see their branch
        if (req.user.role === 'telesale' && req.user.branchId) {
            query += ' AND b.branch_id = ?';
            params.push(req.user.branchId);
        }

        if (branch_id) { query += ' AND b.branch_id = ?'; params.push(branch_id); }
        if (service) { query += ' AND b.service = ?'; params.push(service); }
        if (status) { query += ' AND b.status = ?'; params.push(status); }
        if (date) { query += ' AND DATE(b.appointment_date) = ?'; params.push(date); }
        if (search) {
            query += ' AND (b.full_name LIKE ? OR b.phone LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }
        if (uncalled === 'true') {
            query += ' AND (SELECT COUNT(*) FROM call_logs cl WHERE cl.booking_id = b.id) = 0';
        }

        const validSortFields = ['id', 'full_name', 'phone', 'service', 'appointment_date', 'created_at', 'status'];
        const sortField = validSortFields.includes(sort) ? 'b.' + sort : 'b.created_at';
        const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
        query += ` ORDER BY ${sortField} ${sortOrder}`;

        const bookings = db.prepare(query).all(...params);

        // Stats scoped the same way
        let scopeWhere = '';
        const scopeParams = [];
        if (req.user.role === 'telesale' && req.user.branchId) {
            scopeWhere = ' AND branch_id = ?';
            scopeParams.push(req.user.branchId);
        }

        const stats = {
            total: db.prepare(`SELECT COUNT(*) as count FROM bookings WHERE 1=1${scopeWhere}`).get(...scopeParams).count,
            today: db.prepare(`SELECT COUNT(*) as count FROM bookings WHERE DATE(appointment_date) = DATE('now', 'localtime')${scopeWhere}`).get(...scopeParams).count,
            arrived: db.prepare(`SELECT COUNT(*) as count FROM bookings WHERE status = 'arrived'${scopeWhere}`).get(...scopeParams).count,
            pending: db.prepare(`SELECT COUNT(*) as count FROM bookings WHERE status = 'pending'${scopeWhere}`).get(...scopeParams).count,
            no_show: db.prepare(`SELECT COUNT(*) as count FROM bookings WHERE status = 'no_show'${scopeWhere}`).get(...scopeParams).count,
            uncalled: db.prepare(`SELECT COUNT(*) as count FROM bookings WHERE id NOT IN (SELECT DISTINCT booking_id FROM call_logs)${scopeWhere}`).get(...scopeParams).count,
        };

        res.json({ bookings, stats });
    } catch (error) {
        console.error('Error fetching bookings:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// Update booking status (all authenticated users)
app.patch('/api/bookings/:id', auth, (req, res) => {
    try {
        const { status, notes } = req.body;
        const validStatuses = ['pending', 'arrived', 'no_show'];

        if (status && !validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
        }

        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Không tìm thấy booking' });

        if (status) {
            db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, req.params.id);
            logActivity(req.user.id, req.user.username, req.user.role, 'booking_status_updated',
                `Booking #${req.params.id} ${booking.full_name}: ${booking.status} → ${status}`, req.ip);
        }
        if (notes !== undefined) {
            db.prepare('UPDATE bookings SET notes = ? WHERE id = ?').run(notes, req.params.id);
        }

        const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
        res.json({ message: 'Cập nhật thành công', booking: updated });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// Delete booking (Admin + Trực Page only)
app.delete('/api/bookings/:id', auth, requireRole('admin', 'truc_page'), (req, res) => {
    try {
        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Không tìm thấy booking' });

        db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
        logActivity(req.user.id, req.user.username, req.user.role, 'booking_deleted',
            `Xóa booking #${req.params.id} - ${booking.full_name}`, req.ip);
        res.json({ message: 'Đã xóa thành công' });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== MANUAL BOOKING ENTRY ====================

// Create manual booking (all authenticated users)
app.post('/api/bookings/manual', auth, (req, res) => {
    try {
        const { full_name, phone, service, appointment_date, notes } = req.body;

        if (!full_name || !phone || !service) {
            return res.status(400).json({ error: 'Vui lòng nhập họ tên, SĐT và dịch vụ' });
        }

        const phoneRegex = /^(0|\+84)[0-9]{9,10}$/;
        if (!phoneRegex.test(phone.replace(/\s/g, ''))) {
            return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
        }

        const result = db.prepare(`
            INSERT INTO bookings (full_name, phone, service, appointment_date, notes, source)
            VALUES (?, ?, ?, ?, ?, 'manual')
        `).run(full_name.trim(), phone.trim(), service.trim(), appointment_date, notes || '');

        const newBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);

        logActivity(req.user.id, req.user.username, req.user.role, 'booking_created',
            `Nhập thủ công: ${full_name} - ${phone} - ${service}`, req.ip);

        res.status(201).json({ message: 'Nhập khách hàng thành công!', booking: newBooking });
    } catch (error) {
        console.error('Error creating manual booking:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra, vui lòng thử lại' });
    }
});

// ==================== CALL TRACKING ====================

// Record a call for a booking
app.post('/api/bookings/:id/calls', auth, (req, res) => {
    try {
        const bookingId = req.params.id;
        const { notes } = req.body;

        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        if (!booking) return res.status(404).json({ error: 'Không tìm thấy booking' });

        // Auto-calculate call number
        const lastCall = db.prepare('SELECT MAX(call_number) as max_num FROM call_logs WHERE booking_id = ?').get(bookingId);
        const callNumber = (lastCall.max_num || 0) + 1;

        db.prepare(`
            INSERT INTO call_logs (booking_id, user_id, username, call_number, notes)
            VALUES (?, ?, ?, ?, ?)
        `).run(bookingId, req.user.id, req.user.username, callNumber, notes || '');

        logActivity(req.user.id, req.user.username, req.user.role, 'call_logged',
            `Gọi lần ${callNumber}: ${booking.full_name} - ${booking.phone}`, req.ip);

        const callLog = db.prepare('SELECT * FROM call_logs WHERE booking_id = ? ORDER BY call_number DESC').all(bookingId);

        res.status(201).json({ message: `Đã ghi cuộc gọi lần ${callNumber}`, calls: callLog });
    } catch (error) {
        console.error('Error logging call:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// Get call history for a booking
app.get('/api/bookings/:id/calls', auth, (req, res) => {
    try {
        const bookingId = req.params.id;
        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        if (!booking) return res.status(404).json({ error: 'Không tìm thấy booking' });

        const calls = db.prepare('SELECT * FROM call_logs WHERE booking_id = ? ORDER BY call_number DESC').all(bookingId);
        res.json({ booking, calls });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== ADMIN: USER MANAGEMENT ====================

// List users (Admin only)
app.get('/api/users', auth, requireRole('admin'), (req, res) => {
    const users = db.prepare(`
        SELECT u.id, u.username, u.display_name, u.role, u.active, u.created_at, u.last_login, u.branch_id,
               b.name as branch_name
        FROM users u LEFT JOIN branches b ON u.branch_id = b.id
        ORDER BY u.created_at DESC
    `).all();
    res.json(users);
});

// Create user (Admin only)
app.post('/api/users', auth, requireRole('admin'), (req, res) => {
    try {
        const { username, password, display_name, role, branch_id } = req.body;
        if (!username || !password || !display_name || !role) {
            return res.status(400).json({ error: 'Vui lòng điền đầy đủ thông tin' });
        }

        const validRoles = ['admin', 'truc_page', 'telesale'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({ error: 'Vai trò không hợp lệ' });
        }

        const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (existing) {
            return res.status(400).json({ error: 'Username đã tồn tại' });
        }

        const { hash, salt } = hashPassword(password);
        db.prepare(`
            INSERT INTO users (username, password_hash, salt, display_name, role, branch_id)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(username, hash, salt, display_name, role, branch_id || null);

        logActivity(req.user.id, req.user.username, req.user.role, 'user_created',
            `Tạo user: ${username} (${role})`, req.ip);

        res.status(201).json({ message: 'Tạo user thành công' });
    } catch (error) {
        console.error('Create user error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// Update user (Admin only)
app.patch('/api/users/:id', auth, requireRole('admin'), (req, res) => {
    try {
        const { display_name, role, active, password } = req.body;
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
        if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });

        if (display_name) {
            db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name, req.params.id);
        }
        if (role) {
            const validRoles = ['admin', 'truc_page', 'telesale'];
            if (!validRoles.includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
            db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
        }
        if (req.body.branch_id !== undefined) {
            db.prepare('UPDATE users SET branch_id = ? WHERE id = ?').run(req.body.branch_id || null, req.params.id);
        }
        if (active !== undefined) {
            db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
            if (!active) {
                db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
            }
        }
        if (password) {
            const { hash, salt } = hashPassword(password);
            db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, req.params.id);
        }

        logActivity(req.user.id, req.user.username, req.user.role, 'user_updated',
            `Cập nhật user: ${user.username}`, req.ip);

        res.json({ message: 'Cập nhật thành công' });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// Delete user (Admin only)
app.delete('/api/users/:id', auth, requireRole('admin'), (req, res) => {
    try {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
        if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });

        if (user.id === req.user.id) {
            return res.status(400).json({ error: 'Không thể tự xóa tài khoản của mình' });
        }

        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);

        logActivity(req.user.id, req.user.username, req.user.role, 'user_deleted',
            `Xóa user: ${user.username}`, req.ip);

        res.json({ message: 'Đã xóa user' });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== ADMIN: ACTIVITY LOGS ====================

app.get('/api/logs', auth, requireRole('admin'), (req, res) => {
    try {
        const { limit = 100, offset = 0 } = req.query;
        const logs = db.prepare(`
            SELECT * FROM activity_logs
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `).all(Number(limit), Number(offset));

        const total = db.prepare('SELECT COUNT(*) as count FROM activity_logs').get().count;
        res.json({ logs, total });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});


// ==================== ADMIN: REPORTS ======================================

// Trực Page submits daily contacts count
app.post('/api/reports/truc-page', auth, (req, res) => {
    try {
        const { contacts_count, report_date, notes } = req.body;
        if (!contacts_count || contacts_count < 0) {
            return res.status(400).json({ error: 'Vui lòng nhập số liên hệ hợp lệ' });
        }

        const date = report_date || vnDateStr(new Date());

        // Upsert
        const existing = db.prepare('SELECT id FROM daily_reports WHERE report_date = ? AND user_id = ?').get(date, req.user.id);
        if (existing) {
            db.prepare(`UPDATE daily_reports SET contacts_count = ?, notes = ?, created_at = datetime('now','localtime') WHERE id = ?`)
                .run(contacts_count, notes || '', existing.id);
        } else {
            db.prepare(`INSERT INTO daily_reports (report_date, user_id, username, role, contacts_count, notes) VALUES (?, ?, ?, ?, ?, ?)`)
                .run(date, req.user.id, req.user.username, req.user.role, contacts_count, notes || '');
        }

        logActivity(req.user.id, req.user.username, req.user.role, 'report_submitted',
            `Báo cáo Trực Page: ${contacts_count} liên hệ ngày ${date}`, req.ip);

        res.json({ message: 'Đã ghi báo cáo!' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// Get reports (Admin only)
app.get('/api/reports', auth, (req, res) => {
    try {
        const { days = 14 } = req.query;
        const results = [];

        // Generate date list for last N days
        for (let i = 0; i < Number(days); i++) {
            const d = new Date(Date.now() - i * 86400000);
            const dateStr = vnDateStr(d);

            // Trực Page reports for this date
            const trucPageReports = db.prepare(`
                SELECT dr.*, u.display_name FROM daily_reports dr
                LEFT JOIN users u ON dr.user_id = u.id
                WHERE dr.report_date = ?
                ORDER BY dr.username
            `).all(dateStr);

            // Previous day for data count (bookings received day before)
            const prevDate = new Date(d.getTime() - 86400000);
            const prevDateStr = vnDateStr(prevDate);

            // Data count = bookings created on the report date (what came in)
            const dataCount = db.prepare(`
                SELECT COUNT(*) as c FROM bookings WHERE DATE(created_at) = ?
            `).get(dateStr).c;

            // Data from previous day (for Trực Page rate)
            const prevDayData = db.prepare(`
                SELECT COUNT(*) as c FROM bookings WHERE DATE(created_at) = ?
            `).get(prevDateStr).c;

            // Telesale: appointments created on this date
            const appointmentsToday = db.prepare(`
                SELECT COUNT(*) as c FROM bookings
                WHERE DATE(created_at) = ? AND appointment_date != '' AND appointment_date IS NOT NULL
            `).get(dateStr).c;

            // Telesale: arrived today (bookings with appointment on this date that have status 'arrived')
            const arrivedToday = db.prepare(`
                SELECT COUNT(*) as c FROM bookings
                WHERE status = 'arrived' AND DATE(appointment_date) = ?
            `).get(dateStr).c;

            // Arrival rate = arrived / appointments with date today × 100%
            const appointmentsWithDateToday = db.prepare(`
                SELECT COUNT(*) as c FROM bookings
                WHERE DATE(appointment_date) = ? AND appointment_date != '' AND appointment_date IS NOT NULL
            `).get(dateStr).c;
            const arrivalRate = appointmentsWithDateToday > 0
                ? ((arrivedToday / appointmentsWithDateToday) * 100).toFixed(1)
                : '0.0';

            // Telesale: unique telesale users who logged calls this day
            const telesaleCalls = db.prepare(`
                SELECT cl.username, u.display_name, COUNT(*) as call_count
                FROM call_logs cl
                LEFT JOIN users u ON cl.user_id = u.id
                WHERE DATE(cl.call_time) = ?
                GROUP BY cl.user_id ORDER BY call_count DESC
            `).all(dateStr);

            // Trực Page reports with calculated rates
            const trucPageData = trucPageReports.map(r => {
                const rate = r.contacts_count > 0
                    ? ((prevDayData / r.contacts_count) * 100).toFixed(1)
                    : '0.0';
                return {
                    ...r,
                    prev_day_data: prevDayData,
                    rate
                };
            });

            // Telesale rate
            const telesaleRate = dataCount > 0
                ? ((appointmentsToday / dataCount) * 100).toFixed(1)
                : '0.0';

            results.push({
                date: dateStr,
                day_label: d.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'short', day: '2-digit', month: '2-digit' }),
                data_count: dataCount,
                prev_day_data: prevDayData,
                appointments_today: appointmentsToday,
                truc_page: trucPageData,
                telesale: {
                    calls: telesaleCalls,
                    data_count: dataCount,
                    appointments: appointmentsToday,
                    rate: telesaleRate,
                    arrived_today: arrivedToday,
                    appointments_with_date: appointmentsWithDateToday,
                    arrival_rate: arrivalRate
                }
            });
        }

        res.json(results);
    } catch (error) {
        console.error('Reports error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== BRANCH ROUTES ====================

// Get all branches
app.get('/api/branches', auth, (req, res) => {
    const branches = db.prepare('SELECT * FROM branches WHERE active = 1 ORDER BY id').all();
    res.json(branches);
});

// Create branch (Admin only)
app.post('/api/branches', auth, requireRole('admin'), (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Tên chi nhánh là bắt buộc' });
        db.prepare('INSERT INTO branches (name) VALUES (?)').run(name.trim());
        logActivity(req.user.id, req.user.username, req.user.role, 'branch_created', `Tạo chi nhánh: ${name}`, req.ip);
        res.status(201).json({ message: 'Tạo chi nhánh thành công' });
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== BOOKING ASSIGNMENT (Direct Page → Branch) ====================

// Assign booking to a branch (and optionally a telesales user)
app.post('/api/bookings/:id/assign', auth, (req, res) => {
    try {
        const { branch_id, assigned_to } = req.body;
        if (!branch_id) return res.status(400).json({ error: 'Vui lòng chọn chi nhánh' });

        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Không tìm thấy booking' });

        const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(branch_id);
        if (!branch) return res.status(404).json({ error: 'Chi nhánh không tồn tại' });

        db.prepare(`
            UPDATE bookings SET branch_id = ?, assigned_to = ?, assigned_by = ?, assigned_at = datetime('now','localtime')
            WHERE id = ?
        `).run(branch_id, assigned_to || null, req.user.id, req.params.id);

        logActivity(req.user.id, req.user.username, req.user.role, 'booking_assigned',
            `Phân data #${req.params.id} (${booking.full_name}) → ${branch.name}`, req.ip);

        const updated = db.prepare(`
            SELECT b.*, br.name as branch_name, ua.display_name as assigned_to_name
            FROM bookings b
            LEFT JOIN branches br ON b.branch_id = br.id
            LEFT JOIN users ua ON b.assigned_to = ua.id
            WHERE b.id = ?
        `).get(req.params.id);

        res.json({ message: `Đã phân về ${branch.name}`, booking: updated });
    } catch (error) {
        console.error('Assignment error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== REVENUE TRACKING ====================

// Record first-visit revenue
app.post('/api/bookings/:id/revenue', auth, (req, res) => {
    try {
        const { amount, notes } = req.body;
        if (!amount || amount <= 0) return res.status(400).json({ error: 'Số tiền không hợp lệ' });

        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Không tìm thấy booking' });

        db.prepare(`
            INSERT INTO revenues (booking_id, amount, notes, created_by)
            VALUES (?, ?, ?, ?)
        `).run(req.params.id, amount, notes || '', req.user.id);

        logActivity(req.user.id, req.user.username, req.user.role, 'revenue_recorded',
            `Doanh thu #${req.params.id} (${booking.full_name}): ${Number(amount).toLocaleString('vi-VN')}đ`, req.ip);

        const totalRevenue = db.prepare('SELECT SUM(amount) as total FROM revenues WHERE booking_id = ?').get(req.params.id).total;

        res.status(201).json({ message: 'Đã ghi doanh thu', total_revenue: totalRevenue });
    } catch (error) {
        console.error('Revenue error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// Get revenue for a booking
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

// ==================== ADMIN DASHBOARD KPI ====================

app.get('/api/dashboard/admin', auth, requireRole('admin'), (req, res) => {
    try {
        const today = vnDateStr(new Date());

        // === TRỰC PAGE KPIs ===
        const pageDataToday = db.prepare(`
            SELECT COUNT(*) as c FROM bookings WHERE DATE(created_at) = ? AND source = 'manual'
        `).get(today).c;

        const pageDataTotal = db.prepare(`
            SELECT COUNT(*) as c FROM bookings WHERE source = 'manual'
        `).get().c;

        const pageAssignedToday = db.prepare(`
            SELECT COUNT(*) as c FROM bookings WHERE DATE(assigned_at) = ? AND branch_id IS NOT NULL
        `).get(today).c;

        const pageUnassigned = db.prepare(`
            SELECT COUNT(*) as c FROM bookings WHERE branch_id IS NULL AND source = 'manual'
        `).get().c;

        // By page staff today
        const pageStaffToday = db.prepare(`
            SELECT u.display_name, COUNT(*) as data_count
            FROM bookings b
            LEFT JOIN users u ON b.assigned_by = u.id
            WHERE DATE(b.assigned_at) = ? AND b.branch_id IS NOT NULL
            GROUP BY b.assigned_by ORDER BY data_count DESC
        `).all(today);

        // === TELESALES KPIs ===
        const callsToday = db.prepare(`
            SELECT COUNT(*) as c FROM call_logs WHERE DATE(call_time) = ?
        `).get(today).c;

        const arrivedToday = db.prepare(`
            SELECT COUNT(*) as c FROM bookings WHERE status = 'arrived' AND DATE(appointment_date) = ?
        `).get(today).c;

        const appointmentsToday = db.prepare(`
            SELECT COUNT(*) as c FROM bookings
            WHERE DATE(appointment_date) = ? AND appointment_date IS NOT NULL AND appointment_date != ''
        `).get(today).c;

        const noShowToday = db.prepare(`
            SELECT COUNT(*) as c FROM bookings WHERE status = 'no_show' AND DATE(appointment_date) = ?
        `).get(today).c;

        // Telesales by staff today
        const telesaleStaffToday = db.prepare(`
            SELECT cl.username, u.display_name, COUNT(*) as call_count,
                   u.branch_id, br.name as branch_name
            FROM call_logs cl
            LEFT JOIN users u ON cl.user_id = u.id
            LEFT JOIN branches br ON u.branch_id = br.id
            WHERE DATE(cl.call_time) = ?
            GROUP BY cl.user_id ORDER BY call_count DESC
        `).all(today);

        // === REVENUE BY BRANCH ===
        const revenueByBranch = db.prepare(`
            SELECT br.id, br.name, 
                   COALESCE(SUM(r.amount), 0) as total_revenue,
                   COUNT(DISTINCT r.booking_id) as revenue_count
            FROM branches br
            LEFT JOIN bookings b ON b.branch_id = br.id AND b.status = 'arrived'
            LEFT JOIN revenues r ON r.booking_id = b.id AND DATE(r.created_at) = ?
            WHERE br.active = 1
            GROUP BY br.id ORDER BY br.id
        `).all(today);

        const revenueTodayTotal = db.prepare(`
            SELECT COALESCE(SUM(amount), 0) as total FROM revenues WHERE DATE(created_at) = ?
        `).get(today).total;

        const revenueAllTime = db.prepare(`
            SELECT COALESCE(SUM(amount), 0) as total FROM revenues
        `).get().total;

        // === BRANCH PERFORMANCE ===
        const branchPerformance = db.prepare(`
            SELECT br.id, br.name,
                   (SELECT COUNT(*) FROM bookings WHERE branch_id = br.id) as total_data,
                   (SELECT COUNT(*) FROM bookings WHERE branch_id = br.id AND status = 'arrived') as arrived,
                   (SELECT COUNT(*) FROM bookings WHERE branch_id = br.id AND status = 'pending') as pending,
                   (SELECT COUNT(*) FROM bookings WHERE branch_id = br.id AND status = 'no_show') as no_show,
                   (SELECT COUNT(*) FROM call_logs cl JOIN bookings b ON cl.booking_id = b.id WHERE b.branch_id = br.id AND DATE(cl.call_time) = ?) as calls_today,
                   COALESCE((SELECT SUM(amount) FROM revenues r JOIN bookings b ON r.booking_id = b.id WHERE b.branch_id = br.id), 0) as total_revenue
            FROM branches br WHERE br.active = 1 ORDER BY br.id
        `).all(today);

        res.json({
            truc_page: {
                data_today: pageDataToday,
                data_total: pageDataTotal,
                assigned_today: pageAssignedToday,
                unassigned: pageUnassigned,
                staff_today: pageStaffToday
            },
            telesales: {
                calls_today: callsToday,
                arrived_today: arrivedToday,
                appointments_today: appointmentsToday,
                no_show_today: noShowToday,
                arrival_rate: appointmentsToday > 0 ? ((arrivedToday / appointmentsToday) * 100).toFixed(1) : '0.0',
                staff_today: telesaleStaffToday
            },
            revenue: {
                today: revenueTodayTotal,
                all_time: revenueAllTime,
                by_branch: revenueByBranch
            },
            branches: branchPerformance
        });
    } catch (error) {
        console.error('Admin dashboard error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== PAGE ROUTES ====================

// Login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Dashboard (protected by frontend JS)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin panel
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});



// ==================== START SERVER ====================

app.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════╗
  ║     👑 Hoàn Mỹ CRM Server 👑       ║
  ╠══════════════════════════════════════════╣
  ║                                          ║
  ║  CRM Dashboard:                          ║
  ║  → http://localhost:${PORT}                 ║
  ║  → http://localhost:${PORT}/login           ║
  ║  → http://localhost:${PORT}/admin           ║
  ║                                          ║
  ║  Default Admin: admin / admin123         ║
  ║                                          ║
  ╚══════════════════════════════════════════╝
  `);
});
