// In-memory SSE pub/sub manager with connection limits
// Single PM2 instance so in-memory is fine

var channels = {};
var MAX_CONNECTION_AGE = 4 * 60 * 60 * 1000; // 4 hours
var totalConnections = 0;
var MAX_TOTAL_CONNECTIONS = 1000;
var channelCounts = {};

function unsubscribe(channel, res) {
    if (!channels[channel]) return;
    channels[channel] = channels[channel].filter(function (r) { return r !== res; });
    if (process.env.NODE_ENV !== 'production') console.log('[SSE] unsubscribe:', channel, '→ listeners:', channels[channel].length);
    if (channels[channel].length === 0) delete channels[channel];
    totalConnections = Math.max(0, totalConnections - 1);
    if (channelCounts[channel]) {
        channelCounts[channel] = Math.max(0, channelCounts[channel] - 1);
        if (channelCounts[channel] <= 0) delete channelCounts[channel];
    }
}

// Check if a new subscription can be accepted (call before setupSSE)
function canSubscribe(channel, maxPerChannel) {
    if (totalConnections >= MAX_TOTAL_CONNECTIONS) return false;
    var cc = channelCounts[channel] || 0;
    return cc < (maxPerChannel || 20);
}

function subscribe(channel, res) {
    if (!channels[channel]) channels[channel] = [];
    channels[channel].push(res);
    totalConnections++;
    channelCounts[channel] = (channelCounts[channel] || 0) + 1;
    if (process.env.NODE_ENV !== 'production') console.log('[SSE] subscribe:', channel, '→ listeners:', channels[channel].length, '(total:', totalConnections + ')');

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
    if (process.env.NODE_ENV !== 'production') console.log('[SSE] publish:', channel, '→ listeners:', listeners);
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

function getStats() {
    return { total: totalConnections, channels: Object.keys(channelCounts).length };
}

module.exports = { subscribe, publish, setupSSE, canSubscribe, getStats };
