const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://cardflow:cardflow@localhost:5432/cardflow'
});

pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err.message);
});

module.exports = pool;
