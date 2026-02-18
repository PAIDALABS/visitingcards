#!/bin/bash
# CardFlow VPS Deployment Script
# Usage: ./deploy.sh
# SSH key: ~/.ssh/id_hostinger
# VPS: root@62.72.12.197

set -e

VPS="root@62.72.12.197"
SSH_KEY="$HOME/.ssh/id_hostinger"
REMOTE_DIR="/var/www/cardflow"

echo "=== CardFlow VPS Deployment ==="

# 1. Create directory structure on VPS
echo "1. Creating directories..."
ssh -i $SSH_KEY $VPS "mkdir -p $REMOTE_DIR/server/routes $REMOTE_DIR/public"

# 2. Copy server files
echo "2. Uploading server files..."
scp -i $SSH_KEY server/index.js server/db.js server/auth.js server/sse.js server/email.js server/push.js server/ocr.js server/package.json server/schema.sql server/events-schema.sql server/ecosystem.config.js server/migrate-firebase.js $VPS:$REMOTE_DIR/server/
scp -i $SSH_KEY server/routes/*.js $VPS:$REMOTE_DIR/server/routes/

# 3. Copy .env (if exists)
if [ -f server/.env ]; then
    echo "3. Uploading .env..."
    scp -i $SSH_KEY server/.env $VPS:$REMOTE_DIR/server/
else
    echo "3. WARNING: No .env file found. Copy .env.example and fill in values."
    scp -i $SSH_KEY server/.env.example $VPS:$REMOTE_DIR/server/.env.example
fi

# 4. Copy frontend files to public/
echo "4. Uploading frontend files..."
scp -i $SSH_KEY pages/dashboard.html pages/index.html pages/login.html pages/signup.html pages/landing.html pages/pricing.html pages/reset-password.html pages/event-dashboard.html pages/event.html pages/badge.html pages/booth-dashboard.html pages/booth-setup.html pages/common.js pages/auth.css pages/dashboard.css sw.js manifest.json $VPS:$REMOTE_DIR/public/
# Legal pages
for f in pages/legal/*.html; do
    [ -f "$f" ] && scp -i $SSH_KEY "$f" $VPS:$REMOTE_DIR/public/
done
# Static assets
for f in assets/*; do
    [ -f "$f" ] && scp -i $SSH_KEY "$f" $VPS:$REMOTE_DIR/public/
done

# 5. Copy nginx config
echo "5. Uploading Nginx config..."
scp -i $SSH_KEY server/nginx.conf $VPS:/etc/nginx/sites-available/cardflow

# 6. Install dependencies and setup on VPS
echo "6. Installing dependencies and setting up..."
ssh -i $SSH_KEY $VPS << 'REMOTE'
cd /var/www/cardflow/server
npm install --production

# Setup Nginx
ln -sf /etc/nginx/sites-available/cardflow /etc/nginx/sites-enabled/cardflow
nginx -t && systemctl reload nginx

# Setup PostgreSQL database (if not exists)
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'cardflow'" | grep -q 1 || {
    echo "Creating database..."
    sudo -u postgres createuser -s cardflow 2>/dev/null || true
    sudo -u postgres createdb -O cardflow cardflow
    sudo -u postgres psql -c "ALTER USER cardflow PASSWORD 'cardflow';"
}

# Run schema
cd /var/www/cardflow/server
PGPASSWORD=cardflow psql -U cardflow -d cardflow -f schema.sql 2>/dev/null || true
PGPASSWORD=cardflow psql -U cardflow -d cardflow -f events-schema.sql 2>/dev/null || true

# Create PM2 log directory
mkdir -p /var/log/pm2

# Start/restart with PM2
pm2 stop cardflow 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

echo "Deployment complete!"
REMOTE

echo ""
echo "=== Deployment finished ==="
echo "Server: https://card.cardflow.cloud"
echo ""
echo "Next steps:"
echo "1. Fill in server/.env on VPS with real values"
echo "2. Run migration: ssh -i $SSH_KEY $VPS 'cd $REMOTE_DIR/server && node migrate-firebase.js'"
echo "3. Test all flows end-to-end"
