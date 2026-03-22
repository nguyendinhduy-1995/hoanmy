// ==================== AUTH ====================
const API_TOKEN = localStorage.getItem('crm_token');
const CURRENT_USER = JSON.parse(localStorage.getItem('crm_user') || '{}');

if (!API_TOKEN) {
    window.location.href = '/login';
}

function authHeaders() {
    return { 'Authorization': 'Bearer ' + API_TOKEN, 'Content-Type': 'application/json' };
}

// Verify token on load
fetch('/api/me', { headers: authHeaders() })
    .then(r => { if (!r.ok) { localStorage.removeItem('crm_token'); window.location.href = '/login'; } })
    .catch(() => { });

// ==================== STATE ====================
let currentSort = { field: 'created_at', order: 'desc' };
let searchTimeout = null;
let expandedBookingId = null;
let allBookings = [];

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', () => {
    loadServices();
    loadBookings();
    updateClock();
    setInterval(updateClock, 1000);
    setupRoleUI();
});

function setupRoleUI() {
    const navActions = document.querySelector('.nav-actions');
    if (navActions) {
        const userInfo = document.createElement('span');
        userInfo.className = 'nav-time';
        userInfo.style.marginRight = '8px';
        userInfo.innerHTML = `${CURRENT_USER.displayName || ''}`;
        navActions.prepend(userInfo);
    }
}

// ==================== CLOCK ====================
function updateClock() {
    const el = document.getElementById('navTime');
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric'
    });
}

// ==================== LOAD SERVICES ====================
async function loadServices() {
    try {
        const res = await fetch('/api/services');
        const services = await res.json();

        const select = document.getElementById('filterService');
        if (select) {
            services.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.name;
                opt.textContent = `${s.icon} ${s.name}`;
                select.appendChild(opt);
            });
        }
    } catch (e) {
        console.error('Error loading services:', e);
    }
}

// ==================== LOAD BOOKINGS ====================
async function loadBookings() {
    try {
        const params = new URLSearchParams();
        const service = document.getElementById('filterService')?.value;
        const status = document.getElementById('filterStatus')?.value;
        const date = document.getElementById('filterDate')?.value;
        const search = document.getElementById('searchInput')?.value;

        if (service) params.set('service', service);
        if (status) params.set('status', status);
        if (date) params.set('date', date);
        if (search) params.set('search', search);
        params.set('sort', currentSort.field);
        params.set('order', currentSort.order);

        const res = await fetch(`/api/bookings?${params}`, { headers: authHeaders() });
        if (res.status === 401) { window.location.href = '/login'; return; }
        const data = await res.json();

        allBookings = data.bookings;
        updateStats(data.stats);
        renderBookingCards(data.bookings);

        const countEl = document.getElementById('resultCount');
        if (countEl) countEl.textContent = `${data.bookings.length} kết quả`;
    } catch (e) {
        console.error('Error loading bookings:', e);
    }
}

// ==================== STATS ====================
function updateStats(stats) {
    const map = { statTotal: 'total', statToday: 'today', statArrived: 'arrived', statPending: 'pending', statNoShow: 'no_show' };
    for (const [id, key] of Object.entries(map)) {
        const el = document.getElementById(id);
        if (el) el.textContent = stats[key] || 0;
    }
    const uncalledEl = document.getElementById('statUncalled');
    if (uncalledEl) uncalledEl.textContent = stats.uncalled || 0;
}

// ==================== RENDER BOOKING CARDS ====================
function renderBookingCards(bookings) {
    const container = document.getElementById('bookingCards');
    const tbody = document.getElementById('bookingsTableBody');

    if (!bookings.length) {
        const emptyHTML = `<div class="empty-state"><span class="empty-icon">📋</span><div class="empty-title">Không có dữ liệu</div><div class="empty-text">Thử thay đổi bộ lọc</div></div>`;
        if (container) container.innerHTML = emptyHTML;
        if (tbody) tbody.innerHTML = `<tr><td colspan="8">${emptyHTML}</td></tr>`;
        return;
    }

    const statusMap = {
        pending: { label: '⏳ Chờ xử lý', cls: 'pending' },
        arrived: { label: '✅ Đã đến', cls: 'arrived' },
        no_show: { label: '❌ Không đến', cls: 'no-show' }
    };

    // Render main card list
    if (container) {
        container.innerHTML = bookings.map(b => {
            const st = statusMap[b.status] || statusMap.pending;
            const hasAppt = b.appointment_date && b.appointment_date !== '';
            const apptDate = hasAppt ? new Date(b.appointment_date) : null;
            const dateStr = apptDate ? apptDate.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '';
            const timeStr = apptDate ? apptDate.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' }) : '';
            const callCount = b.call_count || 0;
            const isExpanded = expandedBookingId === b.id;

            // Urgency indicator
            let urgencyClass = '';
            if (callCount === 0 && b.status === 'pending') urgencyClass = 'urgent-high';
            else if (b.status === 'pending') urgencyClass = 'urgent-medium';

            return `<div class="bk-card ${st.cls} ${urgencyClass} ${isExpanded ? 'expanded' : ''}" id="bk-${b.id}" onclick="toggleBookingDetail(${b.id}, event)">
                <div class="bk-card-header">
                    <div class="bk-info-row">
                        <div class="bk-name">${b.full_name}</div>
                        <span class="bk-status-badge ${st.cls}">${st.label}</span>
                    </div>
                    <div class="bk-quick-info">
                        <span class="bk-phone-tag"><a href="tel:${b.phone}" onclick="event.stopPropagation()">📱 ${b.phone}</a></span>
                        <span class="bk-service-tag">💆 ${b.service || 'Chưa xác định'}</span>
                        ${hasAppt ? `<span class="bk-appt-tag">📅 ${dateStr} · ${timeStr}</span>` : '<span class="bk-appt-tag empty">📅 Chưa có lịch</span>'}
                        <span class="bk-call-tag ${callCount === 0 ? 'uncalled' : ''}">📞 ${callCount === 0 ? 'Chưa gọi' : callCount + ' lần'}</span>
                    </div>
                </div>
                <div class="bk-detail-panel" id="detail-${b.id}">
                    ${isExpanded ? '' : '<!-- loaded on expand -->'}
                </div>
            </div>`;
        }).join('');

        // Re-render expanded detail if there was one
        if (expandedBookingId) {
            const b = bookings.find(x => x.id === expandedBookingId);
            if (b) loadBookingDetail(b.id);
        }
    }

    // Also render table for desktop
    if (tbody) {
        const canDelete = CURRENT_USER.role === 'admin' || CURRENT_USER.role === 'truc_page';
        tbody.innerHTML = bookings.map(b => {
            const st = statusMap[b.status] || statusMap.pending;
            const hasAppt = b.appointment_date && b.appointment_date !== '';
            const dateStr = hasAppt ? new Date(b.appointment_date).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '';
            const timeStr = hasAppt ? new Date(b.appointment_date).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' }) : '';
            const createdStr = new Date(b.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            const callCount = b.call_count || 0;
            const callBadge = callCount > 0
                ? `<span class="call-badge" onclick="event.stopPropagation();viewCallHistory(${b.id})" title="Xem lịch sử gọi">📞 ${callCount} lần</span>`
                : `<span class="call-badge uncalled">Chưa gọi</span>`;

            let actions = '';
            actions += `<button class="btn btn-call-log btn-sm" onclick="event.stopPropagation();openCallLogModal(${b.id},'${b.full_name.replace(/'/g, "\\'")}','${b.phone}',${callCount})" title="Ghi cuộc gọi">📞</button>`;
            if (callCount > 0) actions += `<button class="btn btn-call-history btn-sm" onclick="event.stopPropagation();viewCallHistory(${b.id})" title="Lịch sử gọi">📋</button>`;
            if (b.status !== 'arrived') actions += `<button class="btn btn-success btn-sm" onclick="event.stopPropagation();updateStatus(${b.id},'arrived')">✅</button>`;
            if (b.status !== 'no_show') actions += `<button class="btn btn-danger btn-sm" onclick="event.stopPropagation();updateStatus(${b.id},'no_show')">❌</button>`;
            if (b.status !== 'pending') actions += `<button class="btn btn-warning btn-sm" onclick="event.stopPropagation();updateStatus(${b.id},'pending')">↩</button>`;
            if (canDelete) actions += `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openDeleteConfirm(${b.id})">🗑</button>`;

            return `<tr class="clickable-row ${callCount === 0 && b.status === 'pending' ? 'urgent-row' : ''}" onclick="toggleBookingDetail(${b.id}, event)">
                <td>${b.id}</td>
                <td><span class="cell-name">${b.full_name}</span>${b.notes ? `<br><small style="color:var(--text-muted)">${b.notes}</small>` : ''}<br>${callBadge}</td>
                <td class="cell-phone"><a href="tel:${b.phone}" onclick="event.stopPropagation()">${b.phone}</a></td>
                <td><span class="cell-service"><span class="service-dot"></span>${b.service}</span></td>
                <td class="cell-date">${hasAppt ? dateStr + '<br><span style="color:var(--accent-primary);font-weight:600">' + timeStr + '</span>' : '<span style="color:var(--text-muted)">Chưa có lịch</span>'}</td>
                <td class="cell-date">${createdStr}</td>
                <td><span class="badge badge-${st.cls}">${st.label}</span></td>
                <td><div class="cell-actions">${actions}</div></td>
            </tr>
            <tr class="detail-row" id="detailRow-${b.id}" style="display:none">
                <td colspan="8">
                    <div class="inline-detail-panel" id="inlineDetail-${b.id}"></div>
                </td>
            </tr>`;
        }).join('');
    }
}

// ==================== TOGGLE BOOKING DETAIL ====================
async function toggleBookingDetail(bookingId, event) {
    // Don't toggle if clicking on action buttons/links
    if (event && (event.target.closest('button') || event.target.closest('a'))) return;

    const isMobile = window.innerWidth <= 768;

    if (expandedBookingId === bookingId) {
        // Collapse
        expandedBookingId = null;
        if (isMobile) {
            const card = document.getElementById(`bk-${bookingId}`);
            if (card) card.classList.remove('expanded');
            const panel = document.getElementById(`detail-${bookingId}`);
            if (panel) panel.innerHTML = '';
        } else {
            const row = document.getElementById(`detailRow-${bookingId}`);
            if (row) row.style.display = 'none';
        }
        return;
    }

    // Collapse previous
    if (expandedBookingId !== null) {
        if (isMobile) {
            const prevCard = document.getElementById(`bk-${expandedBookingId}`);
            if (prevCard) prevCard.classList.remove('expanded');
            const prevPanel = document.getElementById(`detail-${expandedBookingId}`);
            if (prevPanel) prevPanel.innerHTML = '';
        } else {
            const prevRow = document.getElementById(`detailRow-${expandedBookingId}`);
            if (prevRow) prevRow.style.display = 'none';
        }
    }

    expandedBookingId = bookingId;

    if (isMobile) {
        const card = document.getElementById(`bk-${bookingId}`);
        if (card) card.classList.add('expanded');
    } else {
        const row = document.getElementById(`detailRow-${bookingId}`);
        if (row) row.style.display = '';
    }

    await loadBookingDetail(bookingId);
}

// ==================== LOAD BOOKING DETAIL ====================
async function loadBookingDetail(bookingId) {
    const isMobile = window.innerWidth <= 768;
    const targetEl = isMobile
        ? document.getElementById(`detail-${bookingId}`)
        : document.getElementById(`inlineDetail-${bookingId}`);

    if (!targetEl) return;

    // Show loading
    targetEl.innerHTML = '<div class="detail-loading">🌸 Đang tải chi tiết...</div>';

    const b = allBookings.find(x => x.id === bookingId);
    if (!b) return;

    // Fetch call history
    let calls = [];
    try {
        const res = await fetch(`/api/bookings/${bookingId}/calls`, { headers: authHeaders() });
        const data = await res.json();
        if (res.ok) calls = data.calls || [];
    } catch (e) { /* ignore */ }

    const hasAppt = b.appointment_date && b.appointment_date !== '';
    const apptDate = hasAppt ? new Date(b.appointment_date) : null;
    const dateStr = apptDate ? apptDate.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
    const timeStr = apptDate ? apptDate.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' }) : '';
    const createdStr = new Date(b.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const canDelete = CURRENT_USER.role === 'admin' || CURRENT_USER.role === 'truc_page';

    // Call history HTML
    let callHistoryHTML = '';
    if (calls.length === 0) {
        callHistoryHTML = '<div class="no-calls">📞 Chưa có cuộc gọi nào — hãy gọi ngay!</div>';
    } else {
        callHistoryHTML = '<div class="call-timeline-inline">' + calls.map(c => {
            const d = new Date(c.call_time);
            const tStr = d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            return `<div class="call-entry">
                <div class="call-entry-num">Lần ${c.call_number}</div>
                <div class="call-entry-body">
                    <div class="call-entry-meta">${c.username || ''} · ${tStr}</div>
                    <div class="call-entry-notes">${c.notes || '<em>Không ghi chú</em>'}</div>
                </div>
            </div>`;
        }).join('') + '</div>';
    }

    // Status buttons
    let statusActions = '<div class="detail-actions">';
    statusActions += `<a href="tel:${b.phone}" class="action-btn call" onclick="event.stopPropagation()">
        <span class="action-icon">📱</span> Gọi ngay
    </a>`;
    statusActions += `<button class="action-btn log-call" onclick="event.stopPropagation();openCallLogModal(${b.id},'${b.full_name.replace(/'/g, "\\'")}','${b.phone}',${b.call_count || 0})">
        <span class="action-icon">📝</span> Ghi cuộc gọi
    </button>`;
    if (b.status !== 'arrived') statusActions += `<button class="action-btn arrived" onclick="event.stopPropagation();updateStatus(${b.id},'arrived')"><span class="action-icon">✅</span> Đã đến</button>`;
    if (b.status !== 'no_show') statusActions += `<button class="action-btn no-show" onclick="event.stopPropagation();updateStatus(${b.id},'no_show')"><span class="action-icon">❌</span> Không đến</button>`;
    if (b.status !== 'pending') statusActions += `<button class="action-btn pending" onclick="event.stopPropagation();updateStatus(${b.id},'pending')"><span class="action-icon">↩️</span> Chờ xử lý</button>`;
    if (canDelete) statusActions += `<button class="action-btn delete" onclick="event.stopPropagation();openDeleteConfirm(${b.id})"><span class="action-icon">🗑️</span> Xóa</button>`;
    statusActions += '</div>';

    targetEl.innerHTML = `
        <div class="detail-content">
            <div class="detail-section customer-info">
                <div class="detail-section-title">👤 Thông tin khách hàng</div>
                <div class="detail-grid-info">
                    <div class="info-item">
                        <span class="info-label">Họ tên</span>
                        <span class="info-value">${b.full_name}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">SĐT</span>
                        <span class="info-value"><a href="tel:${b.phone}" class="phone-link" onclick="event.stopPropagation()">${b.phone}</a></span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Dịch vụ</span>
                        <span class="info-value svc">${b.service || 'Chưa xác định'}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Nguồn</span>
                        <span class="info-value">${b.source === 'manual' ? '✍️ Nhập tay' : '🌐 Landing Page'}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Ngày đặt</span>
                        <span class="info-value">${createdStr}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Tên Zalo</span>
                        <span class="info-value">${b.zalo_name || '—'}</span>
                    </div>
                </div>
                ${b.notes ? `<div class="detail-notes">📝 <strong>Ghi chú:</strong> ${b.notes}</div>` : ''}
            </div>
            <div class="detail-section appointment-info">
                <div class="detail-section-title">📅 Lịch hẹn</div>
                ${hasAppt
                    ? `<div class="appt-display"><div class="appt-date">${dateStr}</div><div class="appt-time">${timeStr}</div></div>`
                    : '<div class="no-appt">Chưa có lịch hẹn — cần gọi xác nhận</div>'}
            </div>
            <div class="detail-section call-history-section">
                <div class="detail-section-title">📞 Lịch sử cuộc gọi (${calls.length} cuộc)</div>
                ${callHistoryHTML}
            </div>
            ${statusActions}
        </div>
    `;
}

// ==================== ACTIONS ====================
async function updateStatus(id, status) {
    try {
        const res = await fetch(`/api/bookings/${id}`, {
            method: 'PATCH',
            headers: authHeaders(),
            body: JSON.stringify({ status })
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
        showToast('Cập nhật thành công!');
        loadBookings();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

let deleteBookingId = null;

function openDeleteConfirm(id) {
    deleteBookingId = id;
    const modal = document.getElementById('deleteModal');
    if (modal) modal.classList.add('active');
}

function closeDeleteModal() {
    deleteBookingId = null;
    const modal = document.getElementById('deleteModal');
    if (modal) modal.classList.remove('active');
}

async function confirmDeleteBooking() {
    if (!deleteBookingId) return;
    try {
        const res = await fetch(`/api/bookings/${deleteBookingId}`, {
            method: 'DELETE',
            headers: authHeaders()
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
        showToast('Đã xóa booking');
        closeDeleteModal();
        expandedBookingId = null;
        loadBookings();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('confirmDeleteBtn');
    if (btn) btn.onclick = confirmDeleteBooking;
});

// ==================== SORTING ====================
function sortBy(field) {
    if (currentSort.field === field) {
        currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.field = field;
        currentSort.order = 'desc';
    }
    document.querySelectorAll('.data-table th').forEach(th => th.classList.remove('active'));
    event?.target?.closest('th')?.classList.add('active');
    loadBookings();
}

// ==================== SEARCH ====================
function debounceSearch() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(loadBookings, 300);
}

function clearFilters() {
    const els = ['searchInput', 'filterService', 'filterStatus', 'filterDate'];
    els.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    loadBookings();
}

// ==================== TOAST ====================
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}

// ==================== LOGOUT ====================
function logout() {
    fetch('/api/logout', { method: 'POST', headers: authHeaders() }).finally(() => {
        localStorage.removeItem('crm_token');
        localStorage.removeItem('crm_user');
        window.location.href = '/login';
    });
}

// ==================== MANUAL CUSTOMER ENTRY ====================
function openAddCustomerModal() {
    document.getElementById('mcFullName').value = '';
    document.getElementById('mcPhone').value = '';
    document.getElementById('mcService').value = '';
    document.getElementById('mcAppointment').value = '';
    document.getElementById('mcNotes').value = '';
    document.getElementById('addCustomerModal').classList.add('active');
}

function closeAddCustomerModal() {
    document.getElementById('addCustomerModal').classList.remove('active');
}

async function saveManualCustomer() {
    const full_name = document.getElementById('mcFullName').value.trim();
    const phone = document.getElementById('mcPhone').value.trim();
    const service = document.getElementById('mcService').value.trim();
    const appointment_date = document.getElementById('mcAppointment').value;
    const notes = document.getElementById('mcNotes').value.trim();

    if (!full_name || !phone || !service) {
        showToast('Vui lòng nhập họ tên, SĐT và dịch vụ (*)', 'error');
        return;
    }

    try {
        const res = await fetch('/api/bookings/manual', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ full_name, phone, service, appointment_date, notes })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showToast(data.message);
        closeAddCustomerModal();
        loadBookings();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ==================== CALL LOGGING ====================
function openCallLogModal(bookingId, fullName, phone, callCount) {
    document.getElementById('callBookingId').value = bookingId;
    document.getElementById('callNotes').value = '';
    document.getElementById('callBookingInfo').innerHTML = `
        <div><strong>${fullName}</strong></div>
        <div>📱 <a href="tel:${phone}">${phone}</a></div>
        <div>Đây sẽ là cuộc gọi lần <strong>${(callCount || 0) + 1}</strong></div>
    `;
    document.getElementById('callLogModal').classList.add('active');
}

function closeCallLogModal() {
    document.getElementById('callLogModal').classList.remove('active');
}

async function saveCallLog() {
    const bookingId = document.getElementById('callBookingId').value;
    const notes = document.getElementById('callNotes').value.trim();

    try {
        const res = await fetch(`/api/bookings/${bookingId}/calls`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ notes })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showToast(data.message);
        closeCallLogModal();
        loadBookings();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ==================== CALL HISTORY ====================
async function viewCallHistory(bookingId) {
    const modal = document.getElementById('callHistoryModal');
    const content = document.getElementById('callHistoryContent');
    content.innerHTML = '<div class="call-empty"><span class="call-empty-icon">⏳</span>Đang tải...</div>';
    modal.classList.add('active');

    try {
        const res = await fetch(`/api/bookings/${bookingId}/calls`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        const { booking, calls } = data;
        let html = `<div class="call-booking-info">
            <div><strong>${booking.full_name}</strong> · <a href="tel:${booking.phone}">${booking.phone}</a></div>
            <div>Dịch vụ: ${booking.service}</div>
        </div>`;

        if (!calls.length) {
            html += '<div class="call-empty"><span class="call-empty-icon">📞</span>Chưa có cuộc gọi nào</div>';
        } else {
            html += '<ul class="call-timeline">';
            calls.forEach(c => {
                const d = new Date(c.call_time);
                const timeStr = d.toLocaleString('vi-VN', {
                    timeZone: 'Asia/Ho_Chi_Minh',
                    day: '2-digit', month: '2-digit', year: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                });
                html += `<li class="call-timeline-item">
                    <div class="call-num">${c.call_number}</div>
                    <div class="call-detail">
                        <div class="call-detail-header">
                            <span class="call-user">Lần ${c.call_number} · ${c.username}</span>
                            <span class="call-time">${timeStr}</span>
                        </div>
                        <div class="call-notes-text">${c.notes || '<em style="color:var(--text-muted)">Không có ghi chú</em>'}</div>
                    </div>
                </li>`;
            });
            html += '</ul>';
        }

        content.innerHTML = html;
    } catch (e) {
        content.innerHTML = '<div class="call-empty"><span class="call-empty-icon">❌</span>Lỗi tải dữ liệu</div>';
    }
}

function closeCallHistoryModal() {
    document.getElementById('callHistoryModal').classList.remove('active');
}

// Close modals on background click
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay') && e.target.classList.contains('active')) {
        e.target.classList.remove('active');
    }
});
