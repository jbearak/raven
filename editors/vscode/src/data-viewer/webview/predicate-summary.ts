/**
 * Pure summarizer for FilterPredicates. Used by chip strip labels, aria
 * labels, and the status bar. Output is intentionally short — the chip
 * has limited width — and uses Unicode glyphs so a chip reads like math
 * (≠, ≤, ∈, ∉) without needing CSS.
 *
 * Set-membership summaries truncate after 4 values with `+N more`.
 */

import type { ColumnSchema } from '../arrow-reader';
import type { FilterPredicate } from '../messages';

const SET_TRUNC_AT = 4;

export function summarizePredicate(p: FilterPredicate, col: ColumnSchema): string {
    const n = col.name;
    switch (p.kind) {
        case 'isEmpty': return `${n} is empty`;
        case 'isNotEmpty': return `${n} is not empty`;
        case 'numCompare': return `${n} ${numOp(p.op)} ${p.value}`;
        case 'numBetween':
            return p.inclusive ? `${n} ${p.lo}–${p.hi}` : `${n} (${p.lo}, ${p.hi})`;
        case 'numNotBetween':
            return p.inclusive ? `${n} not in ${p.lo}–${p.hi}` : `${n} not in (${p.lo}, ${p.hi})`;
        case 'setIn': return `${n} ∈ {${summarizeSet(p.values)}}`;
        case 'setNotIn': return `${n} ∉ {${summarizeSet(p.values)}}`;
        case 'strCompare': return `${n} ${p.op === '=' ? '=' : '≠'} "${p.value}"`;
        case 'strContains':
            return `${n} ${p.negate ? 'not contains' : 'contains'} "${p.value}"`;
        case 'strStartsWith': return `${n} starts with "${p.value}"`;
        case 'strEndsWith': return `${n} ends with "${p.value}"`;
        case 'strRegex': return `${n} matches /${p.pattern}/${p.caseSensitive ? '' : 'i'}`;
        case 'dateCompare': return `${n} ${numOp(p.op)} ${p.value}`;
        case 'dateBetween':
            return p.inclusive ? `${n} ${p.lo}–${p.hi}` : `${n} (${p.lo}, ${p.hi})`;
        case 'dateNotBetween':
            return p.inclusive ? `${n} not in ${p.lo}–${p.hi}` : `${n} not in (${p.lo}, ${p.hi})`;
        case 'bool': return `${n} is ${p.value ? 'true' : 'false'}`;
    }
}

function numOp(op: '=' | '!=' | '<' | '<=' | '>' | '>='): string {
    switch (op) {
        case '=': return '=';
        case '!=': return '≠';
        case '<': return '<';
        case '<=': return '≤';
        case '>': return '>';
        case '>=': return '≥';
    }
}

function summarizeSet(values: (string | number)[]): string {
    if (values.length <= SET_TRUNC_AT) return values.join(', ');
    const head = values.slice(0, SET_TRUNC_AT).join(', ');
    const rest = values.length - SET_TRUNC_AT;
    return `${head} +${rest} more`;
}
