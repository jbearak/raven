import { useEffect, type RefObject } from 'react';

export function useDismiss(
    ref: RefObject<HTMLElement>,
    onDismiss: () => void,
): void {
    useEffect(() => {
        function onPointerDown(event: PointerEvent): void {
            const el = ref.current;
            if (!el || el.contains(event.target as Node)) return;
            onDismiss();
        }

        function onKeyDown(event: KeyboardEvent): void {
            if (event.key === 'Escape') onDismiss();
        }

        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
        };
    }, [ref, onDismiss]);
}
