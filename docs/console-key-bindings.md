# Console key bindings

[Docs](README.md) › R session (VS Code)

The keys for moving around and editing the line you're typing in [Raven's console](r-console.md#ravens-console), in each of its two editing styles.

`raven.console.editMode` chooses the style. Both styles come from classic text editors and are standard in terminals, so if your shell already uses one, pick the same one here.

| Style | How it works | Pick it if |
|---|---|---|
| `emacs` (default) | You type normally, and editing commands are `Ctrl` and `Alt` chords, such as `Ctrl+A` for the start of the line. bash and zsh use these by default. | You have no preference. Arrows, Home, End, and Backspace work as usual. |
| `vi` | Two modes. You start in insert mode and type normally. `Esc` switches to normal mode, where letters are commands (`w` jumps a word, `dd` deletes the line), and `i` returns to insert mode. | You use Vim, or vi mode in your shell. |

The console doesn't show which vi mode you're in. If letters you type run as commands, press `i` to get back to insert mode.

> [!TIP]
> On macOS, the `Alt` chords below need the Option key to act as Alt in VS Code's terminal. Turn on `terminal.integrated.macOptionIsMeta` in VS Code's settings; otherwise Option types special characters such as `∫`.

## Keys in both styles

These work in `emacs` style and in vi's insert mode:

| Key | Does |
|---|---|
| `Enter` | Runs the input if it's a complete R expression, otherwise starts a new line |
| `Alt+Enter` | Starts a new line, even if the input is complete |
| `Tab` / `Shift+Tab` | Opens completions and moves through them |
| `Up` / `Down`, `Ctrl+P` / `Ctrl+N` | Earlier and later history entries, or lines within multi-line input |
| `→` or `End` at the end of the line | Accepts the dimmed suggestion from history |
| `Ctrl+R` | Searches history |
| `Home` / `End`, `Ctrl+A` / `Ctrl+E` | Start and end of the line |
| `Ctrl+Left` / `Ctrl+Right` | Previous and next word |
| `Ctrl+W`, `Ctrl+Backspace` | Deletes the word before the cursor |
| `Ctrl+C` | Clears the line, or interrupts R while it runs |
| `Ctrl+D` | Quits, on an empty line |
| `Ctrl+L` | Clears the screen |

## Emacs style

| Key | Does |
|---|---|
| `Ctrl+B` / `Ctrl+F` | Back and forward one character |
| `Alt+B` / `Alt+F` | Back and forward one word |
| `Ctrl+K` | Cuts to the end of the line |
| `Ctrl+U` | Cuts to the start of the line |
| `Alt+D` | Cuts the word after the cursor |
| `Ctrl+Y` | Pastes the text you last cut |
| `Ctrl+T` | Swaps two characters at the cursor |
| `Alt+U` / `Alt+L` | Uppercases or lowercases the word |
| `Alt+C` | Capitalizes the next word's first letter |
| `Ctrl+Z` / `Ctrl+G` | Undo and redo |

## Vi style

In insert mode, the keys in [Keys in both styles](#keys-in-both-styles) work. `Esc` switches to normal mode, where these are commands:

| Keys | Does |
|---|---|
| `h` / `l`, `j` / `k` | Left and right; up and down through lines and history |
| `w` / `b` / `e` | Next word, previous word, end of word (`W`, `B`, `E` count only spaces as word breaks) |
| `0` / `^` / `$` | Start of line, first non-blank, end of line |
| `f` / `t` / `F` / `T` + a character | Jump to or just before that character, forward or back (`;` and `,` repeat) |
| `gg` / `G` | First and last line of multi-line input |
| `i` / `a` / `I` / `A` | Insert before or after the cursor, or at the start or end of the line |
| `x` / `X` | Delete the character under or before the cursor |
| `d`, `c`, `y` + a motion | Delete, change, or copy, as in `dw`, `c$`, or `yb`; `dd`, `cc`, and `yy` act on the whole line |
| `diw`, `ci(`, `da"` | Delete or change inside or around a word, brackets, or quotes |
| `D` / `C` | Delete or change to the end of the line |
| `p` / `P` | Paste after or before the cursor |
| `r` + a character | Replace the character under the cursor |
| `~` | Toggle the case of the character under the cursor |
| `u` | Undo |
| `.` | Repeat the last change |
| `v` | Select text, then `d`, `c`, or `y` it |
| `?` | Search history |

## See also

- [R console](r-console.md)
- [Keybindings](keybinding-comparison.md) for the editor shortcuts that send code to the console
- [Settings reference](settings-reference.md)
