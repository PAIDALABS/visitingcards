// In-memory SSE pub/sub manager
// Single PM2 instance so in-memory is fine

var channels = {};

function subscribe(channel, res) {
    if (!channels[channel]) channels[channel] = [];
    channels[channel].push(res);
    console.log('[SSE] subscribe:', channel, '→ listeners:', channels[channel].length);
    // Heartbeat to detect dead connections
    var heartbeat = setInterval(function () {
        try { res.write(':keepalive\n\n'); } catch (e) { /* handled by close */ }
    }, 30000);
    res.on('close', function () {
        clearInterval(heartbeat);
        channels[channel] = channels[channel].filter(function (r) { return r !== res; });
        console.log('[SSE] unsubscribe:', channel, '→ listeners:', (channels[channel] || []).length);
        if (channels[channel].length === 0) delete channels[channel];
    });
}

function publish(channel, data) {
    var listeners = channels[channel] ? channels[channel].length : 0;
    console.log('[SSE] publish:', channel, '→ listeners:', listeners);
    if (!channels[channel]) return;
    var msg = 'data: ' + JSON.stringify(data) + '\n\n';
    channels[channel].forEach(function (res) {
        try { res.write(msg); } catch (e) { /* connection will be cleaned up on close */ }
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
