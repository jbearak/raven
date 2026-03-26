#!/bin/bash
set -e

echo "Building Raven..."
cargo build --release -p raven

echo "Installing binary to ~/bin..."
mkdir -p ~/bin
# Remove before copying to avoid macOS code-signing cache invalidation (tainted signature → SIGKILL)
rm -f ~/bin/raven
cp target/release/raven ~/bin/raven
chmod +x ~/bin/raven
echo "✓ Binary installed to ~/bin/raven"

echo "Building VS Code extension..."
cd editors/vscode

echo "Copying binary to extension..."
mkdir -p bin
rm -f bin/raven
cp ../../target/release/raven bin/raven

echo "Installing npm dependencies..."
npm install

echo "Compiling TypeScript..."
npm run compile

echo "Packaging extension..."
npm run package

VERSION=$(node -p "require('./package.json').version")
VSIX_FILE="raven-${VERSION}.vsix"
if [ ! -f "$VSIX_FILE" ]; then
    echo "✗ No .vsix file found"
    exit 1
fi

echo "Installing extension to editors..."
EDITORS=("code" "code-insiders" "codium" "kiro" "antigravity" "cursor" "windsurf")
INSTALLED=0

for editor in "${EDITORS[@]}"; do
    if command -v "$editor" &> /dev/null; then
        echo -n "  $editor: "
        if "$editor" --install-extension "$VSIX_FILE" --force &> /dev/null; then
            echo "✓"
            INSTALLED=$((INSTALLED + 1))
        else
            echo "failed"
        fi
    fi
done

if [ $INSTALLED -eq 0 ]; then
    echo "✗ Extension was not installed to any editor"
    exit 1
fi

echo ""
echo "✅ Setup complete!"
echo "   - Binary: ~/bin/raven"
echo "   - Extension: $VSIX_FILE ($INSTALLED editor(s))"
