import { describe, test, expect } from 'bun:test';
import {
    strip_strings_and_comments,
    is_r_line_incomplete,
    is_r_line_continuation,
    detect_r_statement,
    get_upward_bounds,
    get_downward_bounds,
} from '../../editors/vscode/src/send-to-r/statement-detector';

describe('strip_strings_and_comments', () => {
    test('removes comments', () => {
        expect(strip_strings_and_comments('x <- 1 # comment')).toBe('x <- 1 ');
    });

    test('removes double-quoted strings', () => {
        expect(strip_strings_and_comments('x <- "hello"')).toBe('x <- ""');
    });

    test('removes single-quoted strings', () => {
        expect(strip_strings_and_comments("x <- 'world'")).toBe("x <- \"\"");
    });

    test('handles escaped quotes in strings', () => {
        expect(strip_strings_and_comments('x <- "he\\"llo"')).toBe('x <- ""');
    });

    test('removes backtick-quoted names', () => {
        expect(strip_strings_and_comments('`my var` <- 1')).toBe('`` <- 1');
    });

    test('brackets inside strings are removed', () => {
        expect(strip_strings_and_comments('x <- "((("')).toBe('x <- ""');
    });

    test('comment character inside string is not treated as comment', () => {
        expect(strip_strings_and_comments('x <- "# not a comment"')).toBe('x <- ""');
    });
});

describe('is_r_line_incomplete', () => {
    test('simple complete line', () => {
        expect(is_r_line_incomplete('x <- 1')).toBe(false);
    });

    test('empty line', () => {
        expect(is_r_line_incomplete('')).toBe(false);
    });

    test('comment-only line', () => {
        expect(is_r_line_incomplete('# comment')).toBe(false);
    });

    test('trailing comma', () => {
        expect(is_r_line_incomplete('x = foo(a,')).toBe(true);
    });

    test('trailing plus', () => {
        expect(is_r_line_incomplete('x + ')).toBe(true);
    });

    test('trailing pipe |>', () => {
        expect(is_r_line_incomplete('df |>')).toBe(true);
    });

    test('trailing magrittr pipe %>%', () => {
        expect(is_r_line_incomplete('df %>%')).toBe(true);
    });

    test('trailing assignment <-', () => {
        expect(is_r_line_incomplete('x <-')).toBe(true);
    });

    test('trailing right assignment ->', () => {
        expect(is_r_line_incomplete('1 ->')).toBe(true);
    });

    test('trailing tilde', () => {
        expect(is_r_line_incomplete('y ~')).toBe(true);
    });

    test('trailing double colon', () => {
        expect(is_r_line_incomplete('dplyr::')).toBe(true);
    });

    test('trailing triple colon', () => {
        expect(is_r_line_incomplete('pkg:::')).toBe(true);
    });

    test('unmatched open paren', () => {
        expect(is_r_line_incomplete('foo(x,')).toBe(true);
    });

    test('unmatched open bracket', () => {
        expect(is_r_line_incomplete('df[1,')).toBe(true);
    });

    test('unmatched open brace', () => {
        expect(is_r_line_incomplete('if (TRUE) {')).toBe(true);
    });

    test('matched brackets are complete', () => {
        expect(is_r_line_incomplete('foo(x, y)')).toBe(false);
    });

    test('brackets inside strings do not count', () => {
        expect(is_r_line_incomplete('x <- "((("')).toBe(false);
    });

    test('trailing infix operator %in%', () => {
        expect(is_r_line_incomplete('x %in%')).toBe(true);
    });

    test('trailing logical OR', () => {
        expect(is_r_line_incomplete('x ||')).toBe(true);
    });

    test('trailing logical AND', () => {
        expect(is_r_line_incomplete('x &&')).toBe(true);
    });

    test('trailing equals (named arg)', () => {
        expect(is_r_line_incomplete('foo(x =')).toBe(true);
    });

    test('trailing slash (division)', () => {
        expect(is_r_line_incomplete('x /')).toBe(true);
    });

    test('trailing caret (power)', () => {
        expect(is_r_line_incomplete('x ^')).toBe(true);
    });
});

describe('is_r_line_continuation', () => {
    test('line starting with pipe', () => {
        expect(is_r_line_continuation('  |> filter(x > 1)')).toBe(true);
    });

    test('line starting with magrittr pipe', () => {
        expect(is_r_line_continuation('  %>% select(a)')).toBe(true);
    });

    test('line starting with closing paren', () => {
        expect(is_r_line_continuation('  )')).toBe(true);
    });

    test('line starting with closing bracket', () => {
        expect(is_r_line_continuation('  ]')).toBe(true);
    });

    test('line starting with closing brace', () => {
        expect(is_r_line_continuation('}')).toBe(true);
    });

    test('line starting with plus', () => {
        expect(is_r_line_continuation('  + geom_point()')).toBe(true);
    });

    test('line starting with comma', () => {
        expect(is_r_line_continuation('  , y = 2')).toBe(true);
    });

    test('normal line is not continuation', () => {
        expect(is_r_line_continuation('x <- 1')).toBe(false);
    });

    test('line starting with infix %in%', () => {
        expect(is_r_line_continuation('  %in% c(1,2)')).toBe(true);
    });
});

describe('detect_r_statement', () => {
    test('single line statement', () => {
        const lines = ['x <- 1', 'y <- 2', 'z <- 3'];
        expect(detect_r_statement(lines, 1)).toEqual({ start_line: 1, end_line: 1 });
    });

    test('multi-line function call (unmatched paren)', () => {
        const lines = [
            'result <- foo(',
            '  x = 1,',
            '  y = 2',
            ')',
            'next_line <- 3',
        ];
        expect(detect_r_statement(lines, 0)).toEqual({ start_line: 0, end_line: 3 });
        expect(detect_r_statement(lines, 2)).toEqual({ start_line: 0, end_line: 3 });
    });

    test('pipe chain', () => {
        const lines = [
            'df |>',
            '  filter(x > 1) |>',
            '  select(a, b)',
            'other <- 1',
        ];
        expect(detect_r_statement(lines, 0)).toEqual({ start_line: 0, end_line: 2 });
        expect(detect_r_statement(lines, 1)).toEqual({ start_line: 0, end_line: 2 });
        expect(detect_r_statement(lines, 2)).toEqual({ start_line: 0, end_line: 2 });
    });

    test('ggplot with + continuation', () => {
        const lines = [
            'ggplot(df, aes(x, y)) +',
            '  geom_point() +',
            '  theme_minimal()',
            '',
        ];
        expect(detect_r_statement(lines, 0)).toEqual({ start_line: 0, end_line: 2 });
    });

    test('cursor on continuation line finds full statement', () => {
        const lines = [
            'x <- foo(',
            '  bar',
            ')',
        ];
        expect(detect_r_statement(lines, 2)).toEqual({ start_line: 0, end_line: 2 });
    });

    test('if/else block', () => {
        const lines = [
            'if (condition) {',
            '  x <- 1',
            '} else {',
            '  x <- 2',
            '}',
        ];
        expect(detect_r_statement(lines, 0)).toEqual({ start_line: 0, end_line: 4 });
    });

    test('trailing assignment', () => {
        const lines = [
            'result <-',
            '  compute_value()',
            'next <- 1',
        ];
        expect(detect_r_statement(lines, 0)).toEqual({ start_line: 0, end_line: 1 });
    });

    test('magrittr pipe chain', () => {
        const lines = [
            'df %>%',
            '  mutate(z = x + y) %>%',
            '  filter(z > 0)',
        ];
        expect(detect_r_statement(lines, 1)).toEqual({ start_line: 0, end_line: 2 });
    });
});

describe('get_upward_bounds', () => {
    test('extends downward to complete statement', () => {
        const lines = [
            'a <- 1',
            'b <- foo(',
            '  x',
            ')',
            'c <- 3',
        ];
        // Cursor on line 1 (start of multi-line), should extend to line 3
        expect(get_upward_bounds(lines, 1)).toEqual({ start_line: 0, end_line: 3 });
    });

    test('single line at cursor', () => {
        const lines = ['a <- 1', 'b <- 2', 'c <- 3'];
        expect(get_upward_bounds(lines, 1)).toEqual({ start_line: 0, end_line: 1 });
    });
});

describe('get_downward_bounds', () => {
    test('extends upward to find statement start', () => {
        const lines = [
            'a <- 1',
            'b <- foo(',
            '  x',
            ')',
            'c <- 3',
        ];
        // Cursor on line 2 (middle of multi-line), should extend up to line 1
        expect(get_downward_bounds(lines, 2)).toEqual({ start_line: 1, end_line: 4 });
    });

    test('cursor at start of statement', () => {
        const lines = ['a <- 1', 'b <- 2', 'c <- 3'];
        expect(get_downward_bounds(lines, 1)).toEqual({ start_line: 1, end_line: 2 });
    });
});
