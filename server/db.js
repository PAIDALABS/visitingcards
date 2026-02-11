const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || (function() { throw new Error('DATABASE_URL environment variable is required'); })()
});

pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err.message);
});

module.exports = pool;
