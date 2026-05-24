import React from 'react';
import { createRoot } from 'react-dom/client';
import '@glideapps/glide-data-grid/dist/index.css';
import './styles.css';
import { App } from './App';
import type { WebviewToExtension } from '../messages';

declare function acquireVsCodeApi(): {
    postMessage(msg: WebviewToExtension): void;
    getState?(): unknown;
    setState?(state: unknown): void;
};

const root = document.getElementById('root');
if (!root) {
    throw new Error('Data viewer root element not found');
}

const vscode = acquireVsCodeApi();
createRoot(root).render(
    <App vscode={vscode} initialState={vscode.getState?.()} />,
);
