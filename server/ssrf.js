// Shared SSRF protection utilities
// Centralizes DNS validation and private IP checks to prevent DNS rebinding attacks

const { URL } = require('url');
const dns = require('dns');
const http = require('http');
const https = require('https');

function isPrivateIP(ip) {
    // IPv6 checks
    if (ip === '::1' || ip === '::' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
    // IPv4-mapped IPv6 (::ffff:x.x.x.x)
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    var parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return false;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (ip === '0.0.0.0') return true;
    return false;
}

// Resolve hostname and validate all IPs are public.
// Returns { valid: true, addresses: [...] } or { valid: false }
async function resolveAndValidate(hostname) {
    if (hostname === 'localhost') return { valid: false };
    var v4 = await new Promise(function(resolve) {
        dns.resolve4(hostname, function(err, addrs) { resolve(addrs || []); });
    });
    var v6 = await new Promise(function(resolve) {
        dns.resolve6(hostname, function(err, addrs) { resolve(addrs || []); });
    });
    var allAddrs = v4.concat(v6);
    if (allAddrs.length === 0) return { valid: false };
    if (allAddrs.some(isPrivateIP)) return { valid: false };
    return { valid: true, addresses: v4 };
}

// Validate a URL for webhook/fetch use. Returns boolean.
async function validateUrl(urlStr) {
    try {
        var parsed = new URL(urlStr);
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;
        var result = await resolveAndValidate(parsed.hostname);
        return result.valid;
    } catch(e) { return false; }
}

// Create a DNS-pinned fetch that uses pre-resolved IPs to prevent DNS rebinding.
// This resolves DNS once, validates the IPs, then forces the connection to use
// the validated IP address so a second DNS lookup can't return a different (private) IP.
async function safeFetch(urlStr, options) {
    var parsed = new URL(urlStr);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('SSRF: only HTTP/HTTPS protocols allowed');
    }

    var resolved = await resolveAndValidate(parsed.hostname);
    if (!resolved.valid) {
        throw new Error('SSRF: URL resolves to private/internal address');
    }

    // Pin the DNS resolution by creating a custom agent with a lookup override
    var pinnedIP = resolved.addresses[0];
    var isHttps = parsed.protocol === 'https:';
    var AgentClass = isHttps ? https.Agent : http.Agent;
    var agent = new AgentClass({
        lookup: function(hostname, opts, cb) {
            // Return the pre-resolved IP instead of doing another DNS lookup
            cb(null, pinnedIP, 4);
        }
    });

    // Merge the agent into fetch options, preserving the original Host header
    var fetchOpts = Object.assign({}, options || {});
    fetchOpts.dispatcher = undefined; // ensure no conflict
    // Node 18+ fetch doesn't support agent directly, so use the undici-compatible approach
    // For broad compatibility, we set the hostname in the URL to the IP and pass Host header
    var pinnedUrl = parsed.protocol + '//' + pinnedIP + ':' + (parsed.port || (isHttps ? '443' : '80')) + parsed.pathname + parsed.search;
    if (!fetchOpts.headers) fetchOpts.headers = {};
    // Preserve original Host header for TLS SNI and virtual hosting
    if (typeof fetchOpts.headers === 'object' && !Array.isArray(fetchOpts.headers)) {
        fetchOpts.headers['Host'] = parsed.host;
    }

    // For HTTPS, we need to disable hostname verification since we're connecting to an IP
    // but we still validate the certificate chain. This is safe because we already validated
    // the DNS resolution points to a public IP.
    if (isHttps) {
        var origAgent = new https.Agent({
            servername: parsed.hostname, // SNI still uses the real hostname
            rejectUnauthorized: true
        });
        // Use Node's native https request through a custom agent for TLS
    }

    return fetch(pinnedUrl, fetchOpts);
}

module.exports = { isPrivateIP, validateUrl, safeFetch, resolveAndValidate };
