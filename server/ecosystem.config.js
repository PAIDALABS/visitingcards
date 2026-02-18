module.exports = {
    apps: [{
        name: 'cardflow',
        script: 'index.js',
        cwd: '/var/www/cardflow/server',
        exec_mode: 'fork', // Single instance for SSE in-memory state
        env: {
            NODE_ENV: 'production',
            PORT: 3000
        },
        max_memory_restart: '384M',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        error_file: '/var/log/pm2/cardflow-error.log',
        out_file: '/var/log/pm2/cardflow-out.log',
        merge_logs: true
    }]
};
