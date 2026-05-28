/**
 * Entry point for the toolbar-wrap real-layout test harness webview.
 * Mirrors `webview/main.tsx` but mounts `HarnessApp` (toolbar-only, no
 * data/grid layer). Built to `dist-test/` and never shipped.
 */

import { createRoot } from 'react-dom/client';
import { HarnessApp } from './harness-app';

const container = document.getElementById('root');
if (!container) {
    throw new Error('Toolbar wrap harness root element not found');
}

createRoot(container).render(<HarnessApp />);
