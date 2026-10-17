#!/bin/bash
set -e
cd -P "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/python -m pip install -r backend/requirements.lock.txt
fi
if [ ! -f frontend/dist/index.html ]; then
  echo '前端尚未构建，请按照 README 中的开发说明构建。'
  read -r -p '按回车退出'
  exit 1
fi
export PYTHONPATH="$PWD/backend"
if .venv/bin/python -c "import json,urllib.request; r=json.load(urllib.request.urlopen('http://127.0.0.1:8765/api/health',timeout=1)); assert r.get('name')=='有数'" 2>/dev/null; then
  open 'http://127.0.0.1:8765'
  exit 0
fi
(.venv/bin/python -c "import time,urllib.request,webbrowser
for _ in range(40):
 try:
  urllib.request.urlopen('http://127.0.0.1:8765/api/health',timeout=1)
  webbrowser.open('http://127.0.0.1:8765'); break
 except Exception: time.sleep(.5)
") &
echo '有数已启动。请保留此窗口；关闭服务请按 Control+C。'
exec .venv/bin/python -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8765
