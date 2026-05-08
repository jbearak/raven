import './styles.css';
import App from './App.svelte';
import { mount } from 'svelte';

// The VS Code webview API is exposed as `acquireVsCodeApi`. Cast loosely;
// we only need `postMessage` and `addEventListener` on `window`.
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

mount(App, {
    target: document.body,
    props: { vscode },
});
