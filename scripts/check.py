"""Project checks use synthetic data/temp ledgers and never open a browser."""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--backend-only", action="store_true")
parser.add_argument("--frontend-only", action="store_true")
args = parser.parse_args()
if not args.frontend_only:
    subprocess.run([sys.executable, "-m", "pytest", "-q"], cwd=root, check=True)
if not args.backend_only:
    node = shutil.which("node")
    if not node:
        raise SystemExit("请先安装 Node.js 24 并确保 node 位于 PATH")
    frontend = root / "frontend"
    for command in (
        [node, "node_modules/typescript/bin/tsc", "-b"],
        [node, "scripts/test.cjs"],
        [node, "node_modules/vite/bin/vite.js", "build"],
    ):
        subprocess.run(command, cwd=frontend, check=True)
