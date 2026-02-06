// In-memory SSE pub/sub manager
// Single PM2 instance so in-memory is fine

var channels = {};

function subscribe(channel, res) {
    if (!channels[channel]) channels[channel] = [];
    channels[channel].push(res);
    // Heartbeat to detect dead connections
    var heartbeat = setInterval(function () {
        try { res.write(':keepalive\n\n'); } catch (e) { /* handled by close */ }
    }, 30000);
    res.on('close', function () {
        clearInterval(heartbeat);
        channels[channel] = channels[channel].filter(function (r) { return r !== res; });
        if (channels[channel].length === 0) delete channels[channel];
    });
}

function publish(channel, data) {
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
