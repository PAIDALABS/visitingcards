const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || (function() { throw new Error('DATABASE_URL environment variable is required'); })(),
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000
});

pool.on('error', function (err) {
    console.error('Unexpected database pool error:', err.message);
});

module.exports = pool;
