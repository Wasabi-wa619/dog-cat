#!/bin/sh
# My Workspace を起動します（ブラウザが自動で開きます）
cd "$(dirname "$0")" && exec python3 -m workspace "$@"
