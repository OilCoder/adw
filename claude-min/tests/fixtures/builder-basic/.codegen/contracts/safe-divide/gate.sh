#!/usr/bin/env bash
set -euo pipefail
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
