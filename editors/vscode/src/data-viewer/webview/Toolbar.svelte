<script lang="ts">
    import type { ColumnSchema } from '../arrow-reader';
    import type { Layout } from '../messages';

    interface Props {
        labelsOn: boolean;
        formatOn: boolean;
        digits: number;
        nrow: number;
        columns: ColumnSchema[];
        layout: Layout;
        onToggleColumn: (index: number, hidden: boolean) => void;
    }
    let { labelsOn = $bindable(), formatOn = $bindable(), digits = $bindable(),
          nrow, columns, layout, onToggleColumn }: Props = $props();

    let popoverOpen = $state(false);

    const hiddenSet = $derived(new Set(layout.hiddenColumns));
    const visibleCount = $derived(
        columns.filter((_c, i) => !hiddenSet.has(i)).length,
    );

    function close(): void { popoverOpen = false; }

    function onToggle(index: number, e: Event): void {
        const checked = (e.target as HTMLInputElement).checked;
        // checked = visible; hidden = !checked
        onToggleColumn(index, !checked);
    }
</script>

<div class="toolbar">
    <button
        type="button"
        class="toggle {labelsOn ? 'on' : ''}"
        onclick={() => labelsOn = !labelsOn}
        title="Display label strings instead of numeric codes for factors and labelled columns."
    >
        Labels: {labelsOn ? 'on' : 'off'}
    </button>

    <button
        type="button"
        class="toggle {formatOn ? 'on' : ''}"
        onclick={() => formatOn = !formatOn}
        title="Round non-integer numeric columns to N digits."
    >
        Format: {formatOn ? 'on' : 'off'}
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

    <span class="separator"></span>

    <div class="columns-popover-wrapper">
        <button type="button" class="popover-button" onclick={() => popoverOpen = !popoverOpen}>
            Columns ▾
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
    <span class="counter">rows: {nrow.toLocaleString()} &nbsp;cols: {visibleCount}/{columns.length}</span>
</div>
