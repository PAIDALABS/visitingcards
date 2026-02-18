// In-memory SSE pub/sub manager
// Single PM2 instance so in-memory is fine

var channels = {};
var MAX_CONNECTION_AGE = 4 * 60 * 60 * 1000; // 4 hours

function unsubscribe(channel, res) {
    if (!channels[channel]) return;
    channels[channel] = channels[channel].filter(function (r) { return r !== res; });
    console.log('[SSE] unsubscribe:', channel, '→ listeners:', channels[channel].length);
    if (channels[channel].length === 0) delete channels[channel];
}

function subscribe(channel, res) {
    if (!channels[channel]) channels[channel] = [];
    channels[channel].push(res);
    console.log('[SSE] subscribe:', channel, '→ listeners:', channels[channel].length);

    // Heartbeat to detect dead connections — force-close on write error
    var heartbeat = setInterval(function () {
        try {
            var ok = res.write(':keepalive\n\n');
            if (!ok) { cleanup(); }
        } catch (e) {
            cleanup();
        }
    }, 30000);

    // Max connection age to prevent indefinite growth
    var maxAge = setTimeout(function () {
        try { res.end(); } catch (e) {}
        cleanup();
    }, MAX_CONNECTION_AGE);

    var cleaned = false;
    function cleanup() {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        clearTimeout(maxAge);
        unsubscribe(channel, res);
    }

    res.on('close', cleanup);
    res.on('error', cleanup);
}

function publish(channel, data) {
    if (!channels[channel]) return;
    var listeners = channels[channel].length;
    console.log('[SSE] publish:', channel, '→ listeners:', listeners);
    var msg = 'data: ' + JSON.stringify(data) + '\n\n';
    channels[channel].forEach(function (res) {
        try { res.write(msg); } catch (e) { /* cleanup fires on close/error */ }
    });
}

function setupSSE(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('\n');
}

module.exports = { subscribe, publish, setupSSE };
