from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent.parent
skills = ("wox-plugin-creator", "wox-plugin-submit2store")
targets = [f".agents/skills/{name}" for name in skills]
status = subprocess.check_output(["git", "status", "--porcelain", "--", *targets], cwd=root, text=True)
if status:
    sys.exit("Skill files have uncommitted changes; commit or restore them before syncing.\n" + status)

with tempfile.TemporaryDirectory() as temp:
    upstream = Path(temp) / "wox"
    subprocess.run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse",
                    "https://github.com/Wox-launcher/Wox.git", str(upstream)], check=True)
    subprocess.run(["git", "sparse-checkout", "set", *targets], cwd=upstream, check=True)
    subprocess.run([sys.executable, str(root / "scripts/adapt-synced-skill.py")], cwd=upstream, check=True)
    for target in targets:
        source = upstream / target
        if not source.is_dir():
            sys.exit(f"Upstream skill not found: {target}")
    for target in targets:
        destination = root / target
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(upstream / target, destination)

subprocess.run([sys.executable, str(root / "scripts/test-scaffold.py")], cwd=root, check=True)
