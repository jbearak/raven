export { register_r_terminal, get_or_create_r_terminal } from './r-terminal-manager';
export { register_send_to_r_commands } from './commands';
export { create_temp_file, schedule_temp_file_cleanup } from './temp-file';
export {
    detect_r_statement,
    get_upward_bounds,
    get_downward_bounds,
    is_r_line_incomplete,
    is_r_line_continuation,
    strip_strings_and_comments,
} from './statement-detector';
export type { StatementBounds } from './statement-detector';
