"""Run the isolated Godot validation without touching the artist's editor settings."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--godot', default=shutil.which('Godot_v4.7.2-stable_win64_console.exe') or shutil.which('godot'))
parser.add_argument('--import-only', action='store_true')
args = parser.parse_args()
if not args.godot:
    parser.error('Pass --godot path/to/Godot.exe')
root = Path(__file__).resolve().parents[1]
profile = root / 'work' / 'godot-profile'
profile.mkdir(parents=True, exist_ok=True)
env = os.environ.copy()
env['APPDATA'] = str(profile)
evidence = root / 'impasto' / 'evidence'
for mode, flags in [('import', ['--headless', '--editor', '--import']), ('render', ['--', '--qa-quit'])]:
    if args.import_only and mode == 'render':
        break
    result = subprocess.run([args.godot, '--path', str(root / 'impasto'), *flags], env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', errors='replace')
    (evidence / ('godot-' + mode + '.log')).write_text(result.stdout, encoding='utf-8')
    print(mode, 'exit', result.returncode, '\n', result.stdout[-5000:])
    if result.returncode or 'SCRIPT ERROR' in result.stdout:
        raise SystemExit(1)
