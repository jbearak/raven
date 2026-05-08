import './styles.css';
import App from './App.svelte';
import { mount } from 'svelte';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

mount(App, {
    target: document.getElementById('root')!,
    props: { vscode },
});
