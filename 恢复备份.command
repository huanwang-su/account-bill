#!/bin/bash
set -e
cd -P "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then echo '请先运行“启动记账.command”。'; read -r; exit 1; fi
if .venv/bin/python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/api/health',timeout=1)" 2>/dev/null; then
 echo '请先在服务窗口按 Control+C 停止记账服务，再恢复备份。'; read -r; exit 1
fi
backup_path=$(osascript -e 'POSIX path of (choose file with prompt "选择有数账本备份（sqlite3）")')
.venv/bin/python backend/manage.py "$backup_path"
read -r -p '按回车退出'
