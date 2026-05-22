/**
 * GitHub-style syntax-highlighting palettes for the Knit Output
 * rendering pipeline.
 *
 * Two color sets, one per theme variant. Each set maps a small handful
 * of "token roles" — keyword, string, number, comment, function name,
 * etc. — to hex colors taken from GitHub's open-source `primer/primitives`
 * (the same palette `highlight.js`'s `github` / `github-dark` themes
 * use). The set is intentionally narrow: TextMate grammars and Raven's
 * single LSP `function` semantic token together only need a handful of
 * distinct visual roles, and stretching the palette past that point
 * just adds noise.
 *
 * Resolution flow at render time:
 *   1. vscode-textmate gives us TextMate scope arrays for each token
 *      (e.g. `["entity.name.function.r", "source.r"]`).
 *   2. `scopeToRole` walks the scopes and picks the most specific role
 *      that matches.
 *   3. Raven's LSP `function` semantic-token overlay can promote a
 *      span to the `function` role even when the grammar didn't.
 *   4. The role is looked up in the active palette for a hex color.
 *
 * The role names match VS Code's semantic-token type / TextMate scope
 * conventions where possible to keep the mental model consistent.
 */

export type TokenRole =
    | 'keyword'
    | 'string'
    | 'number'
    | 'comment'
    | 'function'
    | 'type'
    | 'variable'
    | 'operator'
    | 'punctuation'
    | 'constant';

export interface GithubPalette {
    /** Page background. */
    background: string;
    /** Default token foreground (no specific role matched). */
    foreground: string;
    /** Per-role color overrides. */
    roles: Record<TokenRole, string>;
}

/**
 * GitHub light palette. Hex values are the same ones `highlight.js`
 * ships in `styles/github.css` for parity with the GitHub UI.
 */
export const githubLight: GithubPalette = {
    background: '#f6f8fa',
    foreground: '#24292f',
    roles: {
        keyword: '#cf222e',
        string: '#0a3069',
        number: '#0550ae',
        comment: '#6e7781',
        function: '#8250df',
        type: '#953800',
        variable: '#953800',
        operator: '#0550ae',
        punctuation: '#24292f',
        constant: '#0550ae',
    },
};

/** GitHub dark palette. Same source as `githubLight`. */
export const githubDark: GithubPalette = {
    background: '#161b22',
    foreground: '#c9d1d9',
    roles: {
        keyword: '#ff7b72',
        string: '#a5d6ff',
        number: '#79c0ff',
        comment: '#8b949e',
        function: '#d2a8ff',
        type: '#ffa657',
        variable: '#ffa657',
        operator: '#79c0ff',
        punctuation: '#c9d1d9',
        constant: '#79c0ff',
    },
};

/**
 * Map a TextMate scope array to a single token role. The TextMate
 * convention is "most specific scope wins" — `entity.name.function.r`
 * trumps `entity.name`, which trumps `source.r`. We walk scopes in
 * reverse (innermost first) so the first match is also the most
 * specific.
 *
 * Returns null when no scope maps to a role we paint, which leaves
 * the token rendered with the palette's `foreground` color.
 */
export function scopeToRole(scopes: readonly string[]): TokenRole | null {
    // Walk innermost → outermost. `scopes` from vscode-textmate is
    // already ordered outermost first, so iterate in reverse.
    for (let i = scopes.length - 1; i >= 0; i--) {
        const role = roleForScope(scopes[i]);
        if (role) return role;
    }
    return null;
}

function roleForScope(scope: string): TokenRole | null {
    // Order matters: the most specific tests come first so a scope
    // like `keyword.operator.assignment.r` doesn't match the generic
    // `keyword.` rule before the operator rule has a chance.
    if (scope.startsWith('comment.')) return 'comment';
    if (scope.startsWith('string.')) return 'string';
    if (
        scope.startsWith('constant.numeric.') ||
        scope === 'constant.numeric'
    ) return 'number';
    if (scope.startsWith('keyword.operator.')) return 'operator';
    if (scope.startsWith('keyword.')) return 'keyword';
    if (
        scope.startsWith('entity.name.function') ||
        scope === 'support.function' ||
        scope.startsWith('support.function.')
    ) return 'function';
    if (
        scope.startsWith('entity.name.type') ||
        scope.startsWith('storage.type.') ||
        scope === 'storage.type'
    ) return 'type';
    if (scope.startsWith('variable.parameter')) return 'variable';
    if (scope.startsWith('variable.')) return 'variable';
    if (scope.startsWith('punctuation.')) return 'punctuation';
    if (
        scope.startsWith('constant.language') ||
        scope.startsWith('constant.other') ||
        scope === 'constant'
    ) return 'constant';
    return null;
}
