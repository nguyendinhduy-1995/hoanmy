require("dotenv").config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const db = require('./database');
const { hashPassword, verifyPassword } = db;

// ==================== FACEBOOK CONFIG ====================
const FB_PIXEL_ID = '2136442863847386';
const FB_CAPI_TOKEN = 'EAATLnB19WSQBQ7pgRxdlFVrRz3fOmP6waaX6ZCRUbZChkwfCb0TcGqtuYfop7H2eRkidnz48GfITPX14KnkjXtK6V5849mYZCFx6Gm6cgZBUFJ0GYeWnt9HUbCUomthbACdTkZCpUQqKhwuCZAeobgS9NHRfaoqmfaoAjJTeDi7nTw6ZAZCICbtk3NXtg1ZCACLrJ1QZDZD';
const FB_API_VERSION = 'v21.0';

const app = express();
const PORT = process.env.PORT || 3000;

// Helper: get Vietnam (UTC+7) date string 'YYYY-MM-DD' for a given Date object
function vnDateStr(d) {
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// Middleware
app.use(cors());
app.use(express.json());

// ==================== SERVICES ====================

const SERVICES = [
    { id: 'cham-soc-da', name: 'Chăm sóc da mặt', icon: '✨' },
    { id: 'triet-long', name: 'Triệt lông', icon: '💫' },
    { id: 'phun-xam', name: 'Phun xăm thẩm mỹ', icon: '🎨' },
    { id: 'massage', name: 'Massage body', icon: '💆' },
    { id: 'nail', name: 'Nail - Làm móng', icon: '💅' },
    { id: 'thanh-loc-da', name: 'Thanh lọc da 14 bước', icon: '🧬' },
];

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
        SELECT s.*, u.id as user_id, u.username, u.display_name, u.role, u.active
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
        role: session.role
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

// Static files (landing pages are public)
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));
app.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));
app.use('/manifest.json', express.static(path.join(__dirname, 'public', 'manifest.json')));
app.use('/sw.js', express.static(path.join(__dirname, 'public', 'sw.js')));

// Landing page routes (public) — inject meta + tracking
app.get('/dat-lich/:serviceId', (req, res) => {
    const serviceId = req.params.serviceId;
    const filePath = path.join(__dirname, 'public', 'landing', `${serviceId}.html`);
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('Dịch vụ không tồn tại');
    }

    let html = fs.readFileSync(filePath, 'utf8');

    // Inject OG meta tags from database
    const meta = db.prepare('SELECT * FROM landing_meta WHERE service_id = ?').get(serviceId);
    if (meta) {
        let ogTags = '';
        if (meta.og_title) ogTags += `<meta property="og:title" content="${meta.og_title}">`;
        if (meta.og_description) ogTags += `<meta property="og:description" content="${meta.og_description}">`;
        if (meta.og_image) ogTags += `<meta property="og:image" content="${meta.og_image}">`;
        if (meta.og_url) ogTags += `<meta property="og:url" content="${meta.og_url}">`;
        ogTags += `<meta property="og:type" content="website">`;
        if (meta.fb_app_id) ogTags += `<meta property="fb:app_id" content="${meta.fb_app_id}">`;
        if (meta.custom_head) ogTags += meta.custom_head;
        if (ogTags) html = html.replace('</head>', ogTags + '\n</head>');
    }

    // Inject FB Pixel + tracking script
    const fbPixel = `<!-- Meta Pixel -->
<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${FB_PIXEL_ID}');fbq('track','PageView');</script>
<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${FB_PIXEL_ID}&ev=PageView&noscript=1"/></noscript>`;
    html = html.replace('</head>', fbPixel + '\n</head>');

    const trackScript = `<script>
(function(){
  var s='${serviceId}',u=new URLSearchParams(location.search);
  fetch('/api/track',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({sid:s,ref:document.referrer,
      us:u.get('utm_source')||'',um:u.get('utm_medium')||'',
      uc:u.get('utm_campaign')||'',ut:u.get('utm_content')||''})
  }).catch(function(){});
})();
</script>`;
    html = html.replace('</body>', trackScript + '\n</body>');

    res.send(html);
});

// ==================== TRACKING ====================

app.post('/api/track', (req, res) => {
    try {
        const { sid, ref, us, um, uc, ut } = req.body;
        if (!sid) return res.status(400).json({ ok: false });

        const ua = req.headers['user-agent'] || '';
        let device = 'desktop';
        if (/mobile|android|iphone|ipad/i.test(ua)) device = 'mobile';
        if (/tablet|ipad/i.test(ua)) device = 'tablet';

        db.prepare(`
            INSERT INTO page_views (service_id, ip_address, user_agent, referrer, utm_source, utm_medium, utm_campaign, utm_content, device_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(sid, req.ip, ua, ref || '', us || '', um || '', uc || '', ut || '', device);

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false });
    }
});

// ==================== FACEBOOK CAPI HELPER ====================
function sha256(value) {
    if (!value) return '';
    return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

function sendFBConversionEvent(eventData) {
    const url = `https://graph.facebook.com/${FB_API_VERSION}/${FB_PIXEL_ID}/events?access_token=${FB_CAPI_TOKEN}`;
    const payload = JSON.stringify({ data: [eventData] });

    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
    }).then(r => r.json()).then(d => {
        console.log('  📊 FB CAPI:', d.events_received ? `${d.events_received} event(s) sent` : JSON.stringify(d));
    }).catch(err => {
        console.error('  ❌ FB CAPI error:', err.message);
    });
}

// Public booking endpoint (from landing pages)
app.post('/api/bookings', (req, res) => {
    try {
        const { full_name, phone, service, appointment_date, notes, event_id, source_url, fbc, fbp } = req.body;

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

        // Facebook Conversions API — CompleteRegistration
        const nameParts = full_name.trim().split(/\s+/);
        const firstName = nameParts[nameParts.length - 1] || '';
        const lastName = nameParts.slice(0, -1).join(' ') || '';

        // Normalize phone: 0xxx -> +84xxx
        let normPhone = phone.replace(/\s/g, '');
        if (normPhone.startsWith('0')) normPhone = '+84' + normPhone.slice(1);

        const fbEvent = {
            event_name: 'CompleteRegistration',
            event_time: Math.floor(Date.now() / 1000),
            event_id: event_id || `booking_${result.lastInsertRowid}_${Date.now()}`,
            event_source_url: source_url || req.headers.referer || '',
            action_source: 'website',
            user_data: {
                client_ip_address: req.ip || req.headers['x-forwarded-for'] || '',
                client_user_agent: req.headers['user-agent'] || '',
                fn: sha256(firstName),
                ln: sha256(lastName),
                ph: sha256(normPhone),
                ct: sha256('ho chi minh'),
                country: sha256('vn')
            },
            custom_data: {
                content_name: service,
                content_category: 'Beauty Service',
                value: 299000,
                currency: 'VND'
            }
        };

        // Add fbc/fbp cookies if available
        if (fbc) fbEvent.user_data.fbc = fbc;
        if (fbp) fbEvent.user_data.fbp = fbp;

        sendFBConversionEvent(fbEvent);

        res.status(201).json({
            message: 'Đặt lịch thành công!',
            booking: newBooking,
            event_id: fbEvent.event_id
        });
    } catch (error) {
        console.error('Error creating booking:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra, vui lòng thử lại' });
    }
});

// Get services (public)
app.get('/api/services', (req, res) => {
    res.json(SERVICES);
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
                role: user.role
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

// Get bookings (all authenticated users)
app.get('/api/bookings', auth, (req, res) => {
    try {
        const { service, status, date, search, sort, order, uncalled } = req.query;

        let query = `SELECT b.*,
            (SELECT COUNT(*) FROM call_logs cl WHERE cl.booking_id = b.id) as call_count,
            (SELECT MAX(cl.call_time) FROM call_logs cl WHERE cl.booking_id = b.id) as last_call_time
            FROM bookings b WHERE 1=1`;
        const params = [];

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

        const stats = {
            total: db.prepare('SELECT COUNT(*) as count FROM bookings').get().count,
            today: db.prepare(`SELECT COUNT(*) as count FROM bookings WHERE DATE(appointment_date) = DATE('now', 'localtime')`).get().count,
            arrived: db.prepare(`SELECT COUNT(*) as count FROM bookings WHERE status = 'arrived'`).get().count,
            pending: db.prepare(`SELECT COUNT(*) as count FROM bookings WHERE status = 'pending'`).get().count,
            no_show: db.prepare(`SELECT COUNT(*) as count FROM bookings WHERE status = 'no_show'`).get().count,
            uncalled: db.prepare(`SELECT COUNT(*) as count FROM bookings WHERE id NOT IN (SELECT DISTINCT booking_id FROM call_logs)`).get().count,
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
        SELECT id, username, display_name, role, active, created_at, last_login
        FROM users ORDER BY created_at DESC
    `).all();
    res.json(users);
});

// Create user (Admin only)
app.post('/api/users', auth, requireRole('admin'), (req, res) => {
    try {
        const { username, password, display_name, role } = req.body;
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
            INSERT INTO users (username, password_hash, salt, display_name, role)
            VALUES (?, ?, ?, ?, ?)
        `).run(username, hash, salt, display_name, role);

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

// ==================== ADMIN: LANDING PAGE META ====================

// Get all landing meta (Admin only)
app.get('/api/landing-meta', auth, requireRole('admin'), (req, res) => {
    try {
        const metas = db.prepare('SELECT * FROM landing_meta ORDER BY service_id').all();
        // Merge with SERVICES list
        const result = SERVICES.map(s => {
            const m = metas.find(x => x.service_id === s.id) || {};
            return {
                service_id: s.id,
                service_name: s.name,
                service_icon: s.icon,
                og_title: m.og_title || '',
                og_description: m.og_description || '',
                og_image: m.og_image || '',
                og_url: m.og_url || '',
                fb_app_id: m.fb_app_id || '',
                custom_head: m.custom_head || '',
                active: m.active !== undefined ? m.active : 1,
                has_meta: !!m.service_id
            };
        });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// Save landing meta (Admin only)
app.post('/api/landing-meta/:serviceId', auth, requireRole('admin'), (req, res) => {
    try {
        const { serviceId } = req.params;
        const { og_title, og_description, og_image, og_url, fb_app_id, custom_head } = req.body;

        const existing = db.prepare('SELECT id FROM landing_meta WHERE service_id = ?').get(serviceId);
        if (existing) {
            db.prepare(`
                UPDATE landing_meta SET og_title=?, og_description=?, og_image=?, og_url=?, fb_app_id=?, custom_head=?, updated_at=datetime('now','localtime')
                WHERE service_id=?
            `).run(og_title || '', og_description || '', og_image || '', og_url || '', fb_app_id || '', custom_head || '', serviceId);
        } else {
            db.prepare(`
                INSERT INTO landing_meta (service_id, og_title, og_description, og_image, og_url, fb_app_id, custom_head)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(serviceId, og_title || '', og_description || '', og_image || '', og_url || '', fb_app_id || '', custom_head || '');
        }

        logActivity(req.user.id, req.user.username, req.user.role, 'landing_meta_updated',
            `Cập nhật meta: ${serviceId}`, req.ip);

        res.json({ message: 'Đã lưu thẻ Meta' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});
// ==================== ADMIN: REPORTS ====================

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

// ==================== ADMIN: ANALYTICS ====================

app.get('/api/analytics', auth, requireRole('admin'), (req, res) => {
    try {
        const { days = 30, service_id } = req.query;
        const daysAgo = `datetime('now','localtime','-${Number(days)} days')`;

        let serviceFilter = '';
        const params = [];
        if (service_id) {
            serviceFilter = 'AND service_id = ?';
            params.push(service_id);
        }

        // Overview stats
        const totalViews = db.prepare(`SELECT COUNT(*) as c FROM page_views WHERE created_at >= ${daysAgo} ${serviceFilter}`).get(...params).c;
        const totalBookings = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE created_at >= ${daysAgo} ${service_id ? 'AND service = (SELECT name FROM json_each(?) LIMIT 1)' : ''}`).get().c;
        const uniqueIPs = db.prepare(`SELECT COUNT(DISTINCT ip_address) as c FROM page_views WHERE created_at >= ${daysAgo} ${serviceFilter}`).get(...params).c;

        // Daily views (last N days)
        const dailyViews = db.prepare(`
            SELECT DATE(created_at) as date, COUNT(*) as views
            FROM page_views WHERE created_at >= ${daysAgo} ${serviceFilter}
            GROUP BY DATE(created_at) ORDER BY date
        `).all(...params);

        // Daily bookings
        const dailyBookings = db.prepare(`
            SELECT DATE(created_at) as date, COUNT(*) as bookings
            FROM bookings WHERE created_at >= ${daysAgo}
            GROUP BY DATE(created_at) ORDER BY date
        `).all();

        // Views by service
        const byService = db.prepare(`
            SELECT service_id, COUNT(*) as views
            FROM page_views WHERE created_at >= ${daysAgo}
            GROUP BY service_id ORDER BY views DESC
        `).all();

        // Bookings by service
        const bookingsByService = db.prepare(`
            SELECT service, COUNT(*) as bookings
            FROM bookings WHERE created_at >= ${daysAgo}
            GROUP BY service ORDER BY bookings DESC
        `).all();

        // UTM sources
        const utmSources = db.prepare(`
            SELECT utm_source, COUNT(*) as views
            FROM page_views WHERE created_at >= ${daysAgo} AND utm_source != '' ${serviceFilter}
            GROUP BY utm_source ORDER BY views DESC LIMIT 20
        `).all(...params);

        // UTM campaigns
        const utmCampaigns = db.prepare(`
            SELECT utm_campaign, utm_source, COUNT(*) as views
            FROM page_views WHERE created_at >= ${daysAgo} AND utm_campaign != '' ${serviceFilter}
            GROUP BY utm_campaign, utm_source ORDER BY views DESC LIMIT 20
        `).all(...params);

        // Device breakdown
        const devices = db.prepare(`
            SELECT device_type, COUNT(*) as views
            FROM page_views WHERE created_at >= ${daysAgo} ${serviceFilter}
            GROUP BY device_type ORDER BY views DESC
        `).all(...params);

        // Top referrers
        const referrers = db.prepare(`
            SELECT referrer, COUNT(*) as views
            FROM page_views WHERE created_at >= ${daysAgo} AND referrer != '' ${serviceFilter}
            GROUP BY referrer ORDER BY views DESC LIMIT 15
        `).all(...params);

        // Conversion rate by service
        const conversions = SERVICES.map(s => {
            const views = db.prepare(`SELECT COUNT(*) as c FROM page_views WHERE service_id = ? AND created_at >= ${daysAgo}`).get(s.id).c;
            const books = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE service = ? AND created_at >= ${daysAgo}`).get(s.name).c;
            return {
                service_id: s.id,
                service_name: s.name,
                icon: s.icon,
                views,
                bookings: books,
                rate: views > 0 ? ((books / views) * 100).toFixed(1) : '0.0'
            };
        });

        res.json({
            overview: { totalViews, totalBookings, uniqueIPs },
            dailyViews,
            dailyBookings,
            byService,
            bookingsByService,
            utmSources,
            utmCampaigns,
            devices,
            referrers,
            conversions
        });
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
});

// ==================== PANCAKE API (DIRECT PAGE) ====================

const PANCAKE_TOKEN = process.env.PANCAKE_TOKEN || '';
const PANCAKE_PAGE_ID = process.env.PANCAKE_PAGE_ID || '720945527779334';
const PANCAKE_API_V2 = 'https://pages.fm/api/public_api/v2';
const PANCAKE_API_V1 = 'https://pages.fm/api/public_api/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Helper: fix naive UTC timestamps from Pancake (missing 'Z' suffix)
function fixPancakeTS(ts) {
    if (!ts || typeof ts !== 'string') return ts;
    if (!ts.endsWith('Z') && !ts.includes('+') && !ts.includes('-', 10)) {
        return ts + 'Z';
    }
    return ts;
}
function fixConvTimestamps(conv) {
    if (conv.updated_at) conv.updated_at = fixPancakeTS(conv.updated_at);
    if (conv.inserted_at) conv.inserted_at = fixPancakeTS(conv.inserted_at);
    if (conv.tag_histories) {
        conv.tag_histories.forEach(th => { if (th.inserted_at) th.inserted_at = fixPancakeTS(th.inserted_at); });
    }
    return conv;
}

// Get conversations from Pancake
app.get('/api/pancake/conversations', auth, async (req, res) => {
    try {
        const { since, type } = req.query;
        // Pancake API requires epoch timestamps (seconds)
        const sinceEpoch = since 
            ? Math.floor(new Date(since).getTime() / 1000) 
            : Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
        const untilEpoch = Math.floor(Date.now() / 1000);
        const url = `${PANCAKE_API_V2}/pages/${PANCAKE_PAGE_ID}/conversations?access_token=${PANCAKE_TOKEN}&since=${sinceEpoch}&until=${untilEpoch}${type ? '&type=' + type : ''}`;
        
        const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
        const data = await response.json();
        
        if (!data.success) {
            return res.status(400).json({ error: data.message || 'Lỗi Pancake API' });
        }
        
        // Normalize timestamps: Pancake returns naive UTC strings without 'Z'
        if (data.conversations) {
            data.conversations = data.conversations.map(fixConvTimestamps);
        }
        
        res.json(data);
    } catch (error) {
        console.error('Pancake conversations error:', error);
        res.status(500).json({ error: 'Lỗi kết nối Pancake' });
    }
});

// Get messages for a conversation — using Pancake v1 API which supports full messages
app.get('/api/pancake/conversations/:convId/messages', auth, async (req, res) => {
    try {
        const { convId } = req.params;
        const url = `${PANCAKE_API_V1}/pages/${PANCAKE_PAGE_ID}/conversations/${convId}/messages?access_token=${PANCAKE_TOKEN}`;
        
        const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
        const data = await response.json();
        
        if (!data.success && !data.messages) {
            return res.status(400).json({ error: 'Không lấy được tin nhắn' });
        }
        
        // Clean messages: extract text from HTML
        const messages = (data.messages || []).map(m => {
            let text = m.message || '';
            // Strip HTML tags for clean text
            text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
            return {
                id: m.id,
                from: m.from,
                message: text,
                created_time: m.created_time,
                attachments: m.attachments
            };
        }).filter(m => m.message); // only messages with text
        
        res.json({ success: true, messages, conversation: data });
    } catch (error) {
        console.error('Pancake messages error:', error);
        res.status(500).json({ error: 'Lỗi kết nối Pancake' });
    }
});

// OpenAI-powered AI Report endpoint — deep analysis of all conversations
app.post('/api/pancake/ai-report', auth, async (req, res) => {
    try {
        const { conversations } = req.body;
        
        if (!conversations || !conversations.length) {
            return res.status(400).json({ error: 'Không có dữ liệu để phân tích' });
        }

        // Fetch full messages for each conversation (parallel, max 10 at a time)
        const conversationsWithMessages = [];
        const batchSize = 10;
        
        for (let i = 0; i < conversations.length; i += batchSize) {
            const batch = conversations.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(async (conv) => {
                try {
                    const url = `${PANCAKE_API_V1}/pages/${PANCAKE_PAGE_ID}/conversations/${conv.id}/messages?access_token=${PANCAKE_TOKEN}`;
                    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
                    const data = await resp.json();
                    const messages = (data.messages || []).map(m => {
                        let text = (m.message || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
                        return {
                            from: m.from?.name || 'Unknown',
                            message: text,
                            created_time: m.created_time
                        };
                    }).filter(m => m.message);
                    return { ...conv, fullMessages: messages };
                } catch (e) {
                    return { ...conv, fullMessages: [] };
                }
            }));
            conversationsWithMessages.push(...results);
        }

        // Build data string for OpenAI
        let dataText = '';
        conversationsWithMessages.forEach((conv, idx) => {
            const name = conv.from?.name || 'Khách hàng';
            const staff = conv.last_sent_by?.admin_name || 'Chưa phản hồi';
            const hasPhone = conv.has_phone ? 'Có' : 'Không';
            const insertedAt = conv.inserted_at || '';
            const updatedAt = conv.updated_at || '';
            
            dataText += `\n--- CUỘC HỘI THOẠI #${idx + 1} ---\n`;
            dataText += `Khách: ${name}\n`;
            dataText += `Nhân viên phản hồi: ${staff}\n`;
            dataText += `Có SĐT: ${hasPhone}\n`;
            dataText += `Tổng tin nhắn: ${conv.message_count || 0}\n`;
            dataText += `Thời gian bắt đầu: ${insertedAt}\n`;
            dataText += `Cập nhật cuối: ${updatedAt}\n`;
            
            if (conv.fullMessages.length > 0) {
                dataText += `\nNỘI DUNG CHAT:\n`;
                conv.fullMessages.forEach(m => {
            const time = m.created_time ? new Date(m.created_time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '';
                    dataText += `[${time}] ${m.from}: ${m.message}\n`;
                });
            } else {
                dataText += `Snippet: ${conv.snippet || '(không có)'}\n`;
            }
        });

        const systemPrompt = `Bạn là Leader Trực Page cấp cao, có 10 năm kinh nghiệm quản lý đội ngũ inbox, telesales và chăm sóc khách hàng tại Viện Thẩm Mỹ Quốc Tế Hoàn Mỹ. Nhiệm vụ của bạn là đọc TOÀN BỘ tin nhắn trực Page trong ngày và ĐÁNH GIÁ TỔNG THỂ như một trưởng bộ phận thực chiến, cực kỳ chi tiết, thẳng thắn, không nể nang.

LƯU Ý QUAN TRỌNG: Múi giờ là UTC+7 (Hồ Chí Minh). Tất cả thời gian trong dữ liệu đều là giờ Việt Nam.

BÁO CÁO TỔNG THỂ GỒM CÁC PHẦN SAU (KHÔNG phân tích chi tiết từng cuộc chat — việc đó sẽ làm riêng):

A. ĐÁNH GIÁ TỪNG NHÂN SỰ TRONG NGÀY
Tổng hợp theo từng nhân sự:
- Tổng số khách được xử lý
- Tỷ lệ phản hồi đúng tốc độ (dưới 5 phút = nhanh)
- Tỷ lệ khách bị chậm phản hồi  
- Tỷ lệ lấy được số điện thoại
- Tỷ lệ chốt lịch
- Tỷ lệ khách bị rơi
- Tỷ lệ khách cần follow-up mà chưa follow
- Lỗi lặp đi lặp lại nhiều nhất
- Điểm mạnh nổi bật nhất
- Điểm yếu nguy hiểm nhất
- Mức độ phù hợp với vị trí trực Page hiện tại

B. PHÁT HIỆN CÁC LỖI NGHIÊM TRỌNG
Phải chỉ ra rõ:
- Những cuộc chat đáng lẽ chốt được nhưng bị tuột (nêu tên khách)
- Những khách có nhu cầu rõ nhưng nhân sự không nhận ra
- Những chỗ trả lời sai tư duy bán hàng
- Những khoảng thời gian phản hồi chậm gây mất khách
- Những câu trả lời hời hợt, thiếu cảm xúc, thiếu dẫn dắt
- Những nhân sự có dấu hiệu làm việc đối phó, không bám KPI

C. GỢI Ý CẢI THIỆN CHUNG
- Cách phản hồi nhanh nhưng vẫn có chiều sâu
- Cách khai thác nhu cầu khéo hơn
- Cách xin số điện thoại tự nhiên hơn
- Cách chốt lịch gọn, chắc, ít mất khách hơn
- Cách follow-up thông minh hơn
- Câu trả lời mẫu tốt hơn ở các tình huống phổ biến

D. KẾT LUẬN CUỐI NGÀY

1. TỔNG QUAN TOÀN BỘ TEAM
- Tổng số hội thoại
- Tỷ lệ phản hồi nhanh
- Tỷ lệ lấy số
- Tỷ lệ chốt lịch
- Tỷ lệ rơi khách
- Vấn đề lớn nhất của cả team hôm nay

2. XẾP HẠNG NHÂN SỰ TRỰC PAGE
- Xếp hạng từ tốt nhất đến kém nhất
- Kèm điểm tổng /100
- Kèm nhận xét ngắn, thẳng

3. TOP 5 LỖI NGHIÊM TRỌNG NHẤT TRONG NGÀY

4. TOP 5 CƠ HỘI CHỐT BỊ BỎ LỠ

5. ĐỀ XUẤT HÀNH ĐỘNG NGAY NGÀY MAI
- Nhân sự nào cần chỉnh ngay
- Cần training gì
- Cần sửa rule gì
- Cần đặt KPI gì về tốc độ phản hồi, lấy số, chốt lịch, follow-up

QUY TẮC BẮT BUỘC:
- Nhận xét thẳng, rõ, không nịnh
- Không nói chung chung
- Mỗi nhận xét phải bám vào dữ liệu chat thực tế
- Chỗ nào tốt thì nói rõ vì sao tốt
- Chỗ nào yếu thì nói rõ yếu ở đâu, hậu quả gì, sửa thế nào
- Luôn ưu tiên mục tiêu chuyển đổi: lấy số điện thoại, chốt lịch, giữ khách, không để rơi lead
- Với mỗi lỗi, phải đưa ví dụ câu nói tốt hơn để nhân sự áp dụng ngay

Trả về bằng tiếng Việt, format markdown rõ ràng.`;

        const userMessage = `Dưới đây là DỮ LIỆU ${conversationsWithMessages.length} cuộc hội thoại trực page hôm nay:\n\n${dataText}\n\nHãy phân tích chi tiết theo format đã yêu cầu.`;

        // Call OpenAI
        const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage }
                ],
                max_tokens: 16000,
                temperature: 0.7
            })
        });

        if (!openaiRes.ok) {
            const errData = await openaiRes.json().catch(() => ({}));
            console.error('OpenAI error:', openaiRes.status, errData);
            return res.status(500).json({ error: `Lỗi hệ thống: ${errData.error?.message || openaiRes.statusText}` });
        }

        const openaiData = await openaiRes.json();
        const report = openaiData.choices?.[0]?.message?.content || 'Không có phản hồi từ hệ thống';

        res.json({ 
            success: true, 
            report,
            totalConversations: conversationsWithMessages.length,
            conversationsWithFullChat: conversationsWithMessages.filter(c => c.fullMessages.length > 0).length,
            model: openaiData.model,
            usage: openaiData.usage
        });
    } catch (error) {
        console.error('AI Report error:', error);
        res.status(500).json({ error: 'Lỗi tạo báo cáo: ' + (error.message || '') });
    }
});

// Quick AI analysis for a single conversation (also OpenAI-powered)
app.post('/api/pancake/analyze', auth, async (req, res) => {
    try {
        const { customerName, messages, snippet, hasPhone, convId } = req.body;
        
        // Try to get full messages from v1 API  
        let fullMessages = messages || [];
        if (convId) {
            try {
                const url = `${PANCAKE_API_V1}/pages/${PANCAKE_PAGE_ID}/conversations/${convId}/messages?access_token=${PANCAKE_TOKEN}`;
                const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
                const data = await resp.json();
                if (data.messages && data.messages.length > 0) {
                    fullMessages = data.messages.map(m => ({
                        from: m.from?.name || 'Unknown',
                        message: (m.message || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim(),
                        created_time: m.created_time
                    })).filter(m => m.message);
                }
            } catch (e) { /* fallback to provided messages */ }
        }

        const chatText = fullMessages.map(m => {
            const time = m.created_time ? new Date(m.created_time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '';
            return `[${time}] ${m.from || 'Unknown'}: ${m.message}`;
        }).join('\n');
        
        const prompt = `Phân tích CHI TIẾT cuộc chat với khách "${customerName || 'Khách hàng'}".
Có SĐT: ${hasPhone ? 'Có' : 'Chưa'}.
Múi giờ: UTC+7 (Hồ Chí Minh).

Nội dung chat:
${chatText || snippet || '(không có nội dung)'}

Trả về JSON (không markdown) theo format:
{
  "score": <điểm tổng 0-100>,
  "interest": "nóng|ấm|lạnh",
  "summary": "<1-2 câu tóm tắt>",
  "scoring": {
    "tocDoPhanhoi": <0-100>,
    "khaiThacNhuCau": <0-100>,
    "kyNangTuVan": <0-100>,
    "danDatLaySo": <0-100>,
    "chotLich": <0-100>,
    "followUp": <0-100>,
    "taoThienCam": <0-100>,
    "xuLyTuChoi": <0-100>,
    "bamMucTieu": <0-100>
  },
  "issues": ["<vấn đề 1>", ...],
  "suggestions": ["<gợi ý cải thiện cụ thể 1>", ...],
  "suggestedMessage": "<tin nhắn mẫu tốt nhất để gửi tiếp>",
  "detailAnalysis": "<phân tích chi tiết: tốc độ phản hồi, cách mở đầu, khai thác nhu cầu, dẫn dắt lấy SĐT, chốt lịch, xử lý từ chối, follow-up, có bỏ lỡ tín hiệu mua hàng không, dấu hiệu mất khách>"
}`;

        const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: 'Bạn là Leader Trực Page cấp cao, 10 năm kinh nghiệm quản lý đội inbox tại Viện Thẩm Mỹ Quốc Tế Hoàn Mỹ. Phân tích chi tiết từng cuộc chat: tốc độ phản hồi, kỹ năng khai thác nhu cầu, tư vấn, dẫn dắt lấy số, chốt lịch, follow-up, tạo thiện cảm, xử lý từ chối, bám mục tiêu chuyển đổi. Nhận xét thẳng thắn, không nể nang, bám vào dữ liệu chat thực tế. Trả về JSON thuần, không markdown.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 2000,
                temperature: 0.5
            })
        });

        if (!openaiRes.ok) {
            throw new Error('OpenAI error: ' + openaiRes.statusText);
        }

        const openaiData = await openaiRes.json();
        let content = openaiData.choices?.[0]?.message?.content || '{}';
        // Parse JSON from response (handle markdown code blocks)
        content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        const analysis = JSON.parse(content);
        res.json({ success: true, analysis });
    } catch (error) {
        console.error('Analysis error:', error);
        res.status(500).json({ error: 'Lỗi phân tích: ' + (error.message || '') });
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

// Direct Page support
app.get('/direct-page', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'direct-page.html'));
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════╗
  ║     🌸 Hoàn Mỹ CRM Server 🌸       ║
  ╠══════════════════════════════════════════╣
  ║                                          ║
  ║  CRM Dashboard:                          ║
  ║  → http://localhost:${PORT}                 ║
  ║  → http://localhost:${PORT}/login           ║
  ║  → http://localhost:${PORT}/admin           ║
  ║                                          ║
  ║  Default Admin: admin / admin123         ║
  ║                                          ║
  ║  Landing Pages:                          ║
  ║  → /dat-lich/cham-soc-da                 ║
  ║  → /dat-lich/triet-long                  ║
  ║  → /dat-lich/phun-xam                    ║
  ║  → /dat-lich/massage                     ║
  ║  → /dat-lich/nail                        ║
  ║  → /dat-lich/thanh-loc-da                ║
  ║                                          ║
  ╚══════════════════════════════════════════╝
  `);
});
