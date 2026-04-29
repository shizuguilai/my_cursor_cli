#!/bin/bash
cd /root/.openclaw/workspace/my_cursor_cli/backend
pkill -f gunicorn 2>/dev/null
sleep 1
gunicorn -w 1 -b 127.0.0.1:5001 --timeout 30 --worker-class=eventlet --log-level error app:app
