#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p models/logic models/reason

python -m pip install -U huggingface_hub

python - <<'PY'
from huggingface_hub import hf_hub_download

models = [
    (
        "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
        "qwen2.5-0.5b-instruct-q4_k_m.gguf",
        "models/logic",
    ),
    (
        "openbmb/MiniCPM5-1B-GGUF",
        "MiniCPM5-1B-Q4_K_M.gguf",
        "models/reason",
    ),
]

for repo_id, filename, local_dir in models:
    print(f"Downloading {repo_id} / {filename}")
    hf_hub_download(repo_id=repo_id, filename=filename, local_dir=local_dir)

print("Models ready.")
PY
