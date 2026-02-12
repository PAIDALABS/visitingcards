// CardFlow — Shared Utilities
// Loaded by all pages via <script src="/common.js"></script>

// HTML escape (all 5 special chars)
function escHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
var escapeHtml = escHtml;

// Safe CSS class
function safeClass(s) { return (s || '').replace(/[^a-zA-Z0-9_-]/g, ''); }

// Auth token
function getAuthToken() { return localStorage.getItem('token'); }

// Authenticated API fetch
function apiFetch(path, options) {
    options = options || {};
    options.headers = options.headers || {};
    var token = getAuthToken();
    if (token) options.headers['Authorization'] = 'Bearer ' + token;
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
    }
    return fetch('/api' + path, options).then(function(r) {
        if (r.status === 401) { localStorage.removeItem('token'); localStorage.removeItem('user'); location.href = '/login'; }
        return r;
    });
}

// Toast notification (CSS-class-based: uses .toast, .toast-success, .toast-error classes)
function showToast(msg, type) {
    type = type || 'success';
    var t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function() { t.classList.add('show'); }, 10);
    setTimeout(function() { t.classList.remove('show'); setTimeout(function() { t.remove(); }, 300); }, 3000);
}

// Auth guard: redirect to login if no token
function requireAuth() {
    if (!getAuthToken()) {
        window.location.href = '/login';
        return false;
    }
    return true;
}
