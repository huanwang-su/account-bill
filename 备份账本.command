#!/bin/bash
set -euo pipefail
cd -P "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo '未找到本地运行环境，请先运行“启动记账.command”。'
  exit 1
fi
exec .venv/bin/python backend/backup.py
