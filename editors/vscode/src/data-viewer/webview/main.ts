import './styles.css';
import App from './App.svelte';
import { mount } from 'svelte';

declare function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState?(): unknown;
    setState?(state: unknown): void;
};
const vscode = acquireVsCodeApi();
const initialState = vscode.getState?.();

mount(App, {
    target: document.getElementById('root')!,
    props: { vscode, initialState },
});
