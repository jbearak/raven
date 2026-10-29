/**
 * Low-level Arrow IPC file helpers for the data viewer's projected reader.
 *
 * {@link ArrowSliceReader} reads individual columns (and individual
 * elements) straight from the file instead of decoding whole record
 * batches. That needs three things apache-arrow's public reader doesn't
 * expose as a unit, so they live here:
 *
 *   - **Message framing.** A footer block `{offset, metaDataLength,
 *     bodyLength}` points at an encapsulated message: an optional
 *     continuation marker (`0xFFFFFFFF`, IPC ≥ 0.15), an int32 flatbuffer
 *     length, the flatbuffer, padding to 8 bytes, then the body at
 *     `offset + metaDataLength`. {@link parseRecordBatchHeader} accepts
 *     both the continuation and the legacy (bare length) prefix.
 *   - **Header parsing without per-node objects.** A RecordBatch header
 *     for a 2,000-column frame lists 2,000 FieldNodes and ~4,000 Buffers.
 *     `Message.decode(...).header()` materializes one object per entry;
 *     this module reads the flatbuffer tables directly from a DataView
 *     into typed arrays ({@link parseRecordBatchHeader}) or sums null
 *     counts in place ({@link addNullCounts}). The spike test
 *     (`tests/bun/data-viewer-arrow-projected-spike.test.ts`) checks both
 *     against apache-arrow's own `Message.decode` on real files.
 *   - **Column → node/buffer mapping.** Nodes and buffers are listed in
 *     depth-first field order. {@link buildColumnLayouts} maps each
 *     top-level field to its first node and, for flat types only, its
 *     buffers. Nested types (List, Struct, Union, Map, ...) are never
 *     emitted by the R writer; a file containing one is marked not
 *     projectable and the reader falls back to whole-batch decoding.
 *
 * All offsets are file-absolute JS numbers: files stay well under 2^53
 * bytes, and int64 header fields are read as `lo + hi * 2^32`.
 */

import { DataType, Type } from 'apache-arrow';

/** One footer block (a record batch's location in the file). */
export type FileBlock = {
    offset: number;
    metaDataLength: number;
    bodyLength: number;
};

/** A parsed RecordBatch header. Arrays are indexed by node / buffer
 *  position in the flattened schema. `bodyOffset` is file-absolute. */
export type ParsedHeader = {
    length: number;
    nodeLength: Float64Array;
    nodeNullCount: Float64Array;
    bufferOffset: Float64Array;
    bufferLength: Float64Array;
    compressed: boolean;
    bodyOffset: number;
    /** Approximate retained size, for the header LRU. */
    bytes: number;
};

/** How a top-level column's data is laid out in each record batch. */
export type ColumnLayout = {
    /** Index of this field's node in `ParsedHeader.node*`. */
    nodeIndex: number;
    /** Index of this field's first buffer, or -1 when not flat. */
    bufferIndex: number;
    /** Number of buffers this field owns (0 for Null, 2 fixed-width, 3 var-width). */
    bufferCount: number;
    /** True iff the field is a flat type the projected reader handles. */
    flat: boolean;
};

const MESSAGE_HEADER_RECORD_BATCH = 3;
const TWO_32 = 4294967296;

function readInt64(dv: DataView, pos: number): number {
    return dv.getUint32(pos, true) + dv.getInt32(pos + 4, true) * TWO_32;
}

/** Absolute position of field `idx` in the flatbuffer table at `table`,
 *  or 0 when the field is absent (default value). */
function fieldPos(dv: DataView, table: number, idx: number): number {
    const vtable = table - dv.getInt32(table, true);
    const vtableLen = dv.getUint16(vtable, true);
    const slot = 4 + 2 * idx;
    if (slot >= vtableLen) return 0;
    const off = dv.getUint16(vtable + slot, true);
    return off === 0 ? 0 : table + off;
}

/** Follow a uoffset stored at `pos`. */
function deref(dv: DataView, pos: number): number {
    return pos + dv.getUint32(pos, true);
}

type RecordBatchTable = {
    dv: DataView;
    length: number;
    nodesStart: number;
    nodesCount: number;
    buffersStart: number;
    buffersCount: number;
    compressed: boolean;
};

/** Locate the RecordBatch table inside an encapsulated message prefix
 *  (`metaDataLength` bytes read from a footer block's offset). Throws on
 *  anything that isn't a RecordBatch message. */
function locateRecordBatch(bytes: Uint8Array): RecordBatchTable {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 8) throw new Error('arrow-ipc: truncated message prefix');
    let base: number;
    let fbLen: number;
    const first = dv.getInt32(0, true);
    if (first === -1) {
        fbLen = dv.getInt32(4, true);
        base = 8;
    } else {
        fbLen = first;
        base = 4;
    }
    if (fbLen <= 0 || base + fbLen > bytes.byteLength) {
        throw new Error('arrow-ipc: bad message length');
    }
    const message = deref(dv, base);
    const headerTypePos = fieldPos(dv, message, 1);
    const headerType = headerTypePos ? dv.getUint8(headerTypePos) : 0;
    if (headerType !== MESSAGE_HEADER_RECORD_BATCH) {
        throw new Error(`arrow-ipc: expected RecordBatch message, got header type ${headerType}`);
    }
    const headerPos = fieldPos(dv, message, 2);
    if (!headerPos) throw new Error('arrow-ipc: RecordBatch message without header');
    const rb = deref(dv, headerPos);
    const lengthPos = fieldPos(dv, rb, 0);
    const nodesPos = fieldPos(dv, rb, 1);
    const buffersPos = fieldPos(dv, rb, 2);
    const compressionPos = fieldPos(dv, rb, 3);
    const nodesVec = nodesPos ? deref(dv, nodesPos) : 0;
    const buffersVec = buffersPos ? deref(dv, buffersPos) : 0;
    return {
        dv,
        length: lengthPos ? readInt64(dv, lengthPos) : 0,
        nodesStart: nodesVec + 4,
        nodesCount: nodesVec ? dv.getUint32(nodesVec, true) : 0,
        buffersStart: buffersVec + 4,
        buffersCount: buffersVec ? dv.getUint32(buffersVec, true) : 0,
        compressed: compressionPos !== 0,
    };
}

/** Parse a RecordBatch message prefix into typed arrays. `block` gives
 *  the body's file position. */
export function parseRecordBatchHeader(bytes: Uint8Array, block: FileBlock): ParsedHeader {
    const t = locateRecordBatch(bytes);
    const { dv } = t;
    const nodeLength = new Float64Array(t.nodesCount);
    const nodeNullCount = new Float64Array(t.nodesCount);
    for (let i = 0; i < t.nodesCount; i++) {
        const p = t.nodesStart + 16 * i;
        nodeLength[i] = readInt64(dv, p);
        nodeNullCount[i] = readInt64(dv, p + 8);
    }
    const bufferOffset = new Float64Array(t.buffersCount);
    const bufferLength = new Float64Array(t.buffersCount);
    for (let i = 0; i < t.buffersCount; i++) {
        const p = t.buffersStart + 16 * i;
        bufferOffset[i] = readInt64(dv, p);
        bufferLength[i] = readInt64(dv, p + 8);
    }
    return {
        length: t.length,
        nodeLength,
        nodeNullCount,
        bufferOffset,
        bufferLength,
        compressed: t.compressed,
        bodyOffset: block.offset + block.metaDataLength,
        bytes: 128 + 16 * (t.nodesCount + t.buffersCount),
    };
}

/** Read only the batch's row count from a message prefix. */
export function recordBatchLength(bytes: Uint8Array): number {
    return locateRecordBatch(bytes).length;
}

/** Add each top-level column's `null_count` from one RecordBatch header
 *  into `out`, reading the FieldNode structs in place (no objects). */
export function addNullCounts(
    bytes: Uint8Array,
    layouts: readonly ColumnLayout[],
    out: Float64Array,
): void {
    const t = locateRecordBatch(bytes);
    for (let c = 0; c < layouts.length; c++) {
        const n = layouts[c].nodeIndex;
        if (n >= t.nodesCount) continue;
        out[c] += readInt64(t.dv, t.nodesStart + 16 * n + 8);
    }
}

/** Number of buffers a flat type owns in the IPC body, or -1 for a type
 *  the projected reader doesn't handle (nested or unknown). */
export function flatBufferCount(type: DataType): number {
    switch (type.typeId) {
        case Type.Null:
            return 0;
        case Type.Bool:
        case Type.Int:
        case Type.Float:
        case Type.Date:
        case Type.Timestamp:
        case Type.Time:
        case Type.Decimal:
        case Type.Interval:
        case Type.Duration:
        case Type.FixedSizeBinary:
        case Type.Dictionary:
            return 2;
        case Type.Utf8:
        case Type.LargeUtf8:
        case Type.Binary:
        case Type.LargeBinary:
            return 3;
        default:
            return -1;
    }
}

/** Nodes a (possibly nested) type contributes to the flattened list. */
function nodeCount(type: DataType): number {
    let n = 1;
    for (const child of (type.children ?? []) as { type: DataType }[]) n += nodeCount(child.type);
    return n;
}

/** Map each top-level field to its node and buffer positions. A field is
 *  `flat` iff {@link flatBufferCount} knows it; buffer positions after the
 *  first non-flat field are unknown (-1). */
export function buildColumnLayouts(types: readonly DataType[]): ColumnLayout[] {
    const out: ColumnLayout[] = [];
    let node = 0;
    let buffer = 0;
    for (const type of types) {
        const count = flatBufferCount(type);
        const flat = count >= 0 && buffer >= 0;
        out.push({
            nodeIndex: node,
            bufferIndex: flat ? buffer : -1,
            bufferCount: flat ? count : 0,
            flat,
        });
        node += nodeCount(type);
        buffer = flat ? buffer + count : -1;
    }
    return out;
}

/** A requested byte range and where its bytes ended up after coalescing. */
export type ReadRequest = {
    pos: number;
    len: number;
    /** Filled once the covering read completes: the backing bytes and the
     *  request's offset within them. */
    buf?: Uint8Array;
    at?: number;
};

/** One merged read covering several {@link ReadRequest}s. */
export type ReadGroup = { start: number; end: number; members: ReadRequest[] };

/** Sort `requests` by position and merge each into the previous group
 *  when the gap between them is at most `gap` bytes. */
export function planCoalescedReads(requests: readonly ReadRequest[], gap: number): ReadGroup[] {
    const order = requests.slice().sort((a, b) => a.pos - b.pos);
    const groups: ReadGroup[] = [];
    let cur: ReadGroup | undefined;
    for (const r of order) {
        if (cur && r.pos <= cur.end + gap) {
            cur.end = Math.max(cur.end, r.pos + r.len);
            cur.members.push(r);
        } else {
            cur = { start: r.pos, end: r.pos + r.len, members: [r] };
            groups.push(cur);
        }
    }
    return groups;
}

/** Point every member of `group` into `buf`, which holds the group's bytes. */
export function assignGroup(group: ReadGroup, buf: Uint8Array): void {
    for (const m of group.members) {
        m.buf = buf;
        m.at = m.pos - group.start;
    }
}

/**
 * Serve `requests` with as few synchronous reads as possible (see
 * {@link planCoalescedReads}). `read(buf, pos)` must behave like
 * `fs.readSync`. Returns the number of merged reads issued.
 */
export function coalescedReadSync(
    read: (buf: Uint8Array, pos: number) => number,
    requests: readonly ReadRequest[],
    gap: number,
): number {
    const groups = planCoalescedReads(requests, gap);
    for (const g of groups) {
        const buf = new Uint8Array(g.end - g.start);
        let got = 0;
        while (got < buf.length) {
            const n = read(buf.subarray(got), g.start + got);
            if (n <= 0) throw new Error('arrow-ipc: short read');
            got += n;
        }
        assignGroup(g, buf);
    }
    return groups.length;
}
