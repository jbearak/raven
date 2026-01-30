#!/bin/bash
set -e

echo "Building Rlsp..."
cargo build --release -p rlsp

echo "Installing binary to ~/bin..."
mkdir -p ~/bin
cp target/release/rlsp ~/bin/rlsp
chmod +x ~/bin/rlsp
echo "✓ Binary installed to ~/bin/rlsp"

echo "Building VS Code extension..."
cd editors/vscode

echo "Copying binary to extension..."
mkdir -p bin
cp ../../target/release/rlsp bin/rlsp

echo "Installing npm dependencies..."
npm install

echo "Compiling TypeScript..."
npm run compile

echo "Packaging extension..."
npm run package

echo "Installing extension to VS Code..."
VSIX_FILE=$(ls rlsp-*.vsix | head -n 1)
if [ -n "$VSIX_FILE" ]; then
    code --install-extension "$VSIX_FILE"
    echo "✓ Extension installed: $VSIX_FILE"
else
    echo "✗ No .vsix file found"
    exit 1
fi

echo ""
echo "✅ Setup complete!"
echo "   - Binary: ~/bin/rlsp"
echo "   - Extension: $VSIX_FILE"