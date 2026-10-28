#!/bin/bash
# Installs dependencies, adds Forklin to the Ubuntu app launcher and puts `forklin` on your PATH (~/.local/bin).
set -euo pipefail
APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# The launcher execs node_modules/.bin/electron; without it the icon silently does nothing.
if [ ! -x "$APP_DIR/node_modules/.bin/electron" ]; then
  command -v npm >/dev/null || { echo "npm not found. Install a current Node.js (https://nodejs.org or nvm; apt's is often too old), then re-run." >&2; exit 1; }
  (cd "$APP_DIR" && npm install)
fi
mkdir -p "$HOME/.local/share/applications" "$HOME/.local/bin" "$HOME/.local/share/icons"
cp "$APP_DIR/assets/forklin.svg" "$HOME/.local/share/icons/forklin.svg"
ln -sf "$APP_DIR/bin/forklin" "$HOME/.local/bin/forklin"
cat > "$HOME/.local/share/applications/forklin.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Forklin
Comment=Local Git client with a commit graph, repo tabs and one-click rebase
Exec=$APP_DIR/bin/forklin %F
Icon=$HOME/.local/share/icons/forklin.svg
Terminal=false
Categories=Development;RevisionControl;
StartupWMClass=forklin
DESKTOP
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
echo "Installed. Launch from the app grid, or run: forklin /path/to/repo"
