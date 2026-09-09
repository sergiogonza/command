#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
mkdir -p memory models/logical models/reason
python -m uvicorn app:app --host 127.0.0.1 --port 7070
