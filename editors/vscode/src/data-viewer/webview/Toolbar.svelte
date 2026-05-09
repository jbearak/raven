<script lang="ts">
    import type { ColumnSchema } from '../arrow-reader';
    import type { Layout } from '../messages';
    import { hasFormatEffect, hasLabelsEffect } from './toolbar-effects';
    import { describeShape } from './shape-description';

    interface Props {
        labelsOn: boolean;
        formatOn: boolean;
        digits: number;
        nrow: number;
        columns: ColumnSchema[];
        layout: Layout;
        objectClass?: string;
        onToggleColumn: (index: number, hidden: boolean) => void;
    }
    let { labelsOn = $bindable(), formatOn = $bindable(), digits = $bindable(),
          nrow, columns, layout, objectClass, onToggleColumn }: Props = $props();

    let popoverOpen = $state(false);

    const hiddenSet = $derived(new Set(layout.hiddenColumns));
    const hiddenCount = $derived(layout.hiddenColumns.length);
    const formatHasEffect = $derived(hasFormatEffect(columns));
    const labelsHasEffect = $derived(hasLabelsEffect(columns));

    function close(): void { popoverOpen = false; }

    function onToggle(index: number, e: Event): void {
        const checked = (e.target as HTMLInputElement).checked;
        // checked = visible; hidden = !checked
        onToggleColumn(index, !checked);
    }
</script>

<div class="toolbar">
    {#if labelsHasEffect}
        <button
            type="button"
            class="toggle {labelsOn ? 'on' : ''}"
            aria-pressed={labelsOn}
            onclick={() => labelsOn = !labelsOn}
            title="Display label strings instead of numeric codes for factors and labelled columns."
        >
            Labels
        </button>
    {/if}

    {#if formatHasEffect}
        <button
            type="button"
            class="toggle {formatOn ? 'on' : ''}"
            aria-pressed={formatOn}
            onclick={() => formatOn = !formatOn}
            title="Round non-integer numeric columns to N digits."
        >
            Format
        </button>

        <select
            class="digits"
            bind:value={digits}
            disabled={!formatOn}
            title="Number of digits when Format is on."
        >
            {#each Array.from({ length: 16 }, (_, i) => i) as d (d)}
                <option value={d}>{d} digits</option>
            {/each}
        </select>
    {/if}

    <span class="separator"></span>

    <div class="columns-popover-wrapper">
        <button
            type="button"
            class="popover-button"
            onclick={() => popoverOpen = !popoverOpen}
            title={hiddenCount > 0
                ? `Show / hide columns (${hiddenCount} hidden)`
                : 'Show / hide columns'}
        >
            Columns ▾
            {#if hiddenCount > 0}
                <span class="hidden-count-badge" aria-hidden="true">{hiddenCount}</span>
            {/if}
        </button>
        {#if popoverOpen}
            <div class="popover" role="dialog">
                <div class="popover-header">
                    <span>Show columns</span>
                    <button type="button" class="popover-close" onclick={close}>×</button>
                </div>
                <div class="popover-body">
                    {#each columns as col, i (i)}
                        <label class="column-row">
                            <input
                                type="checkbox"
                                checked={!hiddenSet.has(i)}
                                onchange={(e) => onToggle(i, e)}
                            />
                            <span class="column-name">{col.name}</span>
                            <span class="column-type">{col.arrowType}</span>
                        </label>
                    {/each}
                </div>
            </div>
        {/if}
    </div>

    <span class="spacer"></span>
    <span class="counter">{describeShape(objectClass, nrow, columns.length)}</span>
</div>
