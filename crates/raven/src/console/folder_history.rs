//! The folder each history entry was typed in, for the suggestion as you type.
//!
//! The console's history (Up, Down, `Ctrl+R`) is one list shared by every
//! folder. The suggestion drawn as you type comes only from entries typed in
//! the current working directory: a suggestion from another project reads as
//! text the console made up.
//!
//! [`RecordingHistory`] is the history reedline uses. Its `save`, which
//! reedline calls when an entry is submitted (before R evaluates it), also
//! records the entry under the working directory at that moment in a
//! [`FolderStore`]. Everything else is the main history's, so Up, Down and
//! `Ctrl+R` are unchanged. The hinter reads the [`FolderStore`] with the
//! working directory at the time it draws, so it follows `setwd()`, and a
//! `setwd()` entry belongs to the folder it was typed in.
//!
//! The store is a second reedline [`FileBackedHistory`] whose rows are the
//! entry behind a fixed-length key for its folder ([`folder_key`]). A prefix
//! search for `key + input` is a search of that folder's entries, and
//! capacity, the newline encoding, file locking and merging with other
//! consoles are reedline's own. Entries with no key (all those saved before
//! folders were recorded, and those typed while the working directory could
//! not be read) are never suggested, and when the folder has no match nothing
//! is suggested: falling back to every folder would bring back the
//! suggestion from another project.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use reedline::{
    FileBackedHistory, History, HistoryItem, HistoryItemId, HistorySessionId, SearchQuery,
};

/// Entries kept in the main history.
pub const MAIN_CAPACITY: usize = 10_000;

/// Rows kept in the folder store, all folders together: the main history's
/// capacity, so a folder's suggestions reach back about as far as Up does.
const CAPACITY: usize = MAIN_CAPACITY;

/// Hex digits of the folder hash (128 bits).
const KEY_HEX: usize = 32;

/// The working directory, `None` when it cannot be read (it was deleted, or
/// a parent is not searchable).
pub fn current_folder() -> Option<PathBuf> {
    std::env::current_dir().ok()
}

/// The key the rows of folder `dir` start with: a fixed-length hash, then a
/// space. The fixed length keeps a prefix search for one folder's rows from
/// matching another's. `None` for no folder.
///
/// On Unix the hash is over the path's bytes as `getcwd` returns them: with
/// symlinks resolved, and on macOS in the spelling on disk, so no folding is
/// needed. On Windows the working directory keeps the spelling it was set
/// with (`setwd("C:/x")` and a terminal started in `c:\X` differ), so the
/// folder is resolved by the file system first, which gives each folder one
/// spelling, its case on disk; `None` when that fails.
pub fn folder_key(dir: Option<&Path>) -> Option<String> {
    let dir = dir?;
    let mut hasher = blake3::Hasher::new();
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        hasher.update(dir.as_os_str().as_bytes());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let resolved = std::fs::canonicalize(dir).ok()?;
        for unit in resolved.as_os_str().encode_wide() {
            hasher.update(&unit.to_le_bytes());
        }
    }
    let mut key = hasher.finalize().to_hex()[..KEY_HEX].to_string();
    key.push(' ');
    Some(key)
}

/// The last folder's key, so a key is worked out once per folder rather than
/// on every keystroke (on Windows it asks the file system).
#[derive(Default)]
pub struct KeyCache(Option<(PathBuf, Option<String>)>);

impl KeyCache {
    pub fn key(&mut self, dir: Option<&Path>) -> Option<String> {
        let dir = dir?;
        match &self.0 {
            Some((last, key)) if last == dir => key.clone(),
            _ => {
                let key = folder_key(Some(dir));
                self.0 = Some((dir.to_path_buf(), key.clone()));
                key
            }
        }
    }
}

/// Where the folder store for history file `history` lives: beside it, with
/// `.folders` added to its name. Absolute, so a relative `--history-file`
/// does not move with `setwd()`: reedline reopens the path at every sync.
/// `None` when it cannot be made absolute.
pub fn store_path(history: &Path) -> Option<PathBuf> {
    let mut name = history.file_name()?.to_os_string();
    name.push(".folders");
    std::path::absolute(history.with_file_name(name)).ok()
}

/// The folder store: entries keyed by the folder they were typed in. Shared
/// by the history, which records, and the hinter, which reads. Both run on
/// the R thread, so the lock is never contended.
#[derive(Clone)]
pub struct FolderStore {
    rows: Arc<Mutex<FileBackedHistory>>,
    /// The file it is kept in; `None` in memory.
    file: Option<Arc<PathBuf>>,
}

impl FolderStore {
    /// A store that lives only as long as this console.
    pub fn in_memory() -> Self {
        Self {
            rows: Arc::new(Mutex::new(
                FileBackedHistory::new(CAPACITY).expect("in-memory history"),
            )),
            file: None,
        }
    }

    /// The store for the main history kept in `history`: in a file beside
    /// it ([`store_path`]) when `history` is a regular file, and otherwise in
    /// memory. A history redirected to `/dev/null` keeps no commands, and
    /// neither does this.
    pub fn beside(history: &Path) -> Self {
        if std::fs::metadata(history).is_ok_and(|m| m.is_file()) {
            store_path(history)
                .and_then(Self::open)
                .unwrap_or_else(Self::in_memory)
        } else {
            Self::in_memory()
        }
    }

    /// The store kept in `file`, created if missing. `None` when it cannot
    /// be opened.
    fn open(file: PathBuf) -> Option<Self> {
        create_private(&file).ok()?;
        let rows = FileBackedHistory::with_file(CAPACITY, file.clone()).ok()?;
        Some(Self {
            rows: Arc::new(Mutex::new(rows)),
            file: Some(Arc::new(file)),
        })
    }

    fn lock(&self) -> MutexGuard<'_, FileBackedHistory> {
        self.rows.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Record `entry` as typed in folder `dir`; with no folder, nothing.
    pub fn record(&self, dir: Option<&Path>, entry: &str) {
        if let Some(key) = folder_key(dir)
            && !entry.is_empty()
        {
            let _ = self
                .lock()
                .save(HistoryItem::from_command_line(format!("{key}{entry}")));
        }
    }

    /// Run `f` on the keyed rows, for reedline's prefix search.
    pub fn with_rows<R>(&self, f: impl FnOnce(&dyn History) -> R) -> R {
        f(&*self.lock())
    }

    fn sync(&self) -> std::io::Result<()> {
        // reedline re-creates a deleted file with default permissions.
        if let Some(file) = &self.file {
            create_private(file)?;
        }
        self.lock().sync()
    }

    fn clear(&self) -> reedline::Result<()> {
        self.lock().clear()
    }
}

/// Create `file` empty if it is missing, readable only by its owner on Unix:
/// it holds the text of every entry, and must not be more readable than a
/// private history file.
fn create_private(file: &Path) -> std::io::Result<()> {
    if file.exists() {
        return Ok(());
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(file).map(drop)
}

/// The console's history: the main history, plus the folder each entry was
/// saved in.
pub struct RecordingHistory {
    main: FileBackedHistory,
    folders: FolderStore,
}

impl RecordingHistory {
    pub fn new(main: FileBackedHistory, folders: FolderStore) -> Self {
        Self { main, folders }
    }

    /// [`History::save`], with the entry typed in folder `dir`. It is
    /// recorded for the folder whenever the main history accepts it, even
    /// when that skips it as a repeat of its newest entry: that entry may
    /// have been typed in another folder.
    fn save_in(&mut self, h: HistoryItem, dir: Option<&Path>) -> reedline::Result<HistoryItem> {
        let entry = h.command_line.clone();
        let saved = self.main.save(h)?;
        self.folders.record(dir, &entry);
        Ok(saved)
    }
}

impl History for RecordingHistory {
    fn save(&mut self, h: HistoryItem) -> reedline::Result<HistoryItem> {
        self.save_in(h, current_folder().as_deref())
    }

    fn load(&self, id: HistoryItemId) -> reedline::Result<HistoryItem> {
        self.main.load(id)
    }

    fn count(&self, query: SearchQuery) -> reedline::Result<i64> {
        self.main.count(query)
    }

    fn search(&self, query: SearchQuery) -> reedline::Result<Vec<HistoryItem>> {
        self.main.search(query)
    }

    fn update(
        &mut self,
        id: HistoryItemId,
        updater: &dyn Fn(HistoryItem) -> HistoryItem,
    ) -> reedline::Result<()> {
        self.main.update(id, updater)
    }

    fn clear(&mut self) -> reedline::Result<()> {
        let folders = self.folders.clear();
        self.main.clear().and(folders)
    }

    fn delete(&mut self, h: HistoryItemId) -> reedline::Result<()> {
        self.main.delete(h)
    }

    fn sync(&mut self) -> std::io::Result<()> {
        let folders = self.folders.sync();
        self.main.sync().and(folders)
    }

    fn session(&self) -> Option<HistorySessionId> {
        self.main.session()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Real folders: on Windows a key needs the folder to exist.
    pub(crate) struct Dirs {
        _tmp: tempfile::TempDir,
        pub a: PathBuf,
        pub b: PathBuf,
        pub sub: PathBuf,
    }

    pub(crate) fn dirs() -> Dirs {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        let sub = a.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir(&b).unwrap();
        Dirs {
            _tmp: tmp,
            a,
            b,
            sub,
        }
    }

    /// The suggestion for `input` in folder `d`: the rest of its newest
    /// entry that starts with `input`.
    fn suggestion(store: &FolderStore, d: Option<&Path>, input: &str) -> Option<String> {
        let key = folder_key(d)?;
        let keyed = format!("{key}{input}");
        store.with_rows(|h| {
            h.search(SearchQuery::last_with_prefix(keyed.clone(), None))
                .unwrap()
                .first()
                .map(|e| e.command_line[keyed.len()..].to_string())
        })
    }

    fn history_with(folders: FolderStore) -> RecordingHistory {
        RecordingHistory::new(FileBackedHistory::new(100).unwrap(), folders)
    }

    fn save(h: &mut RecordingHistory, entry: &str, d: Option<&Path>) {
        h.save_in(HistoryItem::from_command_line(entry), d).unwrap();
    }

    fn main_entries(h: &RecordingHistory) -> Vec<String> {
        h.search(SearchQuery::everything(
            reedline::SearchDirection::Forward,
            None,
        ))
        .unwrap()
        .into_iter()
        .map(|e| e.command_line)
        .collect()
    }

    #[test]
    fn keys_are_fixed_length_and_distinct_per_folder() {
        let d = dirs();
        let a = folder_key(Some(&d.a)).unwrap();
        assert_eq!(a.len(), KEY_HEX + 1);
        assert!(a.ends_with(' '));
        assert_eq!(folder_key(Some(&d.a)), Some(a.clone()));
        assert_ne!(folder_key(Some(&d.b)), Some(a.clone()));
        assert_ne!(folder_key(Some(&d.sub)), Some(a));
        assert_eq!(folder_key(None), None);
    }

    /// On Unix the key is the bytes `getcwd` gives, which on macOS are the
    /// spelling on disk: two spellings are two folders (as on Linux).
    #[cfg(unix)]
    #[test]
    fn unix_keys_follow_the_bytes() {
        let lower = folder_key(Some(Path::new("/work/a")));
        assert!(lower.is_some());
        assert_ne!(folder_key(Some(Path::new("/work/A"))), lower);
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_folders_keep_distinct_keys() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let one = Path::new(OsStr::from_bytes(b"/work/\xff"));
        let two = Path::new(OsStr::from_bytes(b"/work/\xfe"));
        assert_eq!(one.to_string_lossy(), two.to_string_lossy());
        assert_ne!(folder_key(Some(one)), folder_key(Some(two)));
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_folder_has_one_key_whatever_its_spelling() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("MixedCase");
        std::fs::create_dir(&folder).unwrap();
        let original = folder_key(Some(&folder));
        assert!(original.is_some());
        let upper = PathBuf::from(folder.to_string_lossy().to_uppercase());
        assert_eq!(folder_key(Some(&upper)), original);
        let verbatim = std::fs::canonicalize(&folder).unwrap();
        assert!(verbatim.to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(folder_key(Some(&verbatim)), original);
        let slashes = PathBuf::from(folder.to_string_lossy().replace('\\', "/"));
        assert_eq!(folder_key(Some(&slashes)), original);
    }

    #[test]
    fn the_key_cache_follows_the_folder() {
        let d = dirs();
        let mut cache = KeyCache::default();
        let (a, b) = (folder_key(Some(&d.a)), folder_key(Some(&d.b)));
        assert!(a.is_some() && a != b);
        assert_eq!(cache.key(Some(&d.a)), a);
        assert_eq!(cache.key(Some(&d.b)), b);
        assert_eq!(cache.key(None), None);
        assert_eq!(cache.key(Some(&d.b)), b);
    }

    #[test]
    fn an_entry_is_suggested_only_in_its_folder() {
        let d = dirs();
        let folders = FolderStore::in_memory();
        let mut h = history_with(folders.clone());
        save(&mut h, "print(a(1))", Some(&d.a));
        assert_eq!(
            suggestion(&folders, Some(&d.a), "pr").as_deref(),
            Some("int(a(1))")
        );
        // No fallback to other folders, nor to a parent or child folder.
        assert_eq!(suggestion(&folders, Some(&d.b), "pr"), None);
        assert_eq!(suggestion(&folders, Some(&d.sub), "pr"), None);
        // Up, Down and Ctrl+R still see it.
        assert_eq!(main_entries(&h), ["print(a(1))"]);
    }

    #[test]
    fn with_no_folder_nothing_is_recorded() {
        let folders = FolderStore::in_memory();
        let mut h = history_with(folders.clone());
        save(&mut h, "x <- 1", None);
        assert_eq!(main_entries(&h), ["x <- 1"]);
        let rows = folders.with_rows(|h| {
            h.search(SearchQuery::everything(
                reedline::SearchDirection::Forward,
                None,
            ))
            .unwrap()
            .len()
        });
        assert_eq!(rows, 0);
    }

    #[test]
    fn an_entry_repeated_in_another_folder_is_recorded_there_too() {
        let d = dirs();
        let folders = FolderStore::in_memory();
        let mut h = history_with(folders.clone());
        save(&mut h, "summary(d)", Some(&d.a));
        // The main history skips the repeat of its newest entry.
        save(&mut h, "summary(d)", Some(&d.b));
        assert_eq!(main_entries(&h), ["summary(d)"]);
        for dir in [&d.a, &d.b] {
            assert_eq!(
                suggestion(&folders, Some(dir), "summ").as_deref(),
                Some("ary(d)")
            );
        }
    }

    #[test]
    fn the_newest_entry_of_the_folder_wins() {
        let d = dirs();
        let folders = FolderStore::in_memory();
        let mut h = history_with(folders.clone());
        save(&mut h, "plot(x)", Some(&d.a));
        save(&mut h, "plot(y)", Some(&d.b));
        assert_eq!(
            suggestion(&folders, Some(&d.a), "plot(").as_deref(),
            Some("x)")
        );
        save(&mut h, "plot(z)\n  # two lines", Some(&d.a));
        assert_eq!(
            suggestion(&folders, Some(&d.a), "plot(").as_deref(),
            Some("z)\n  # two lines")
        );
    }

    #[test]
    fn the_store_is_kept_beside_the_history_file() {
        let d = dirs();
        let tmp = tempfile::tempdir().unwrap();
        let hist = tmp.path().join("console_history");
        let main = FileBackedHistory::with_file(100, hist.clone()).unwrap();
        let folders = FolderStore::beside(&hist);
        let mut h = RecordingHistory::new(main, folders);
        save(&mut h, "a <- 1\nb <- 2", Some(&d.a));
        h.sync().unwrap();
        drop(h);
        // The history file is unchanged: bare entries.
        assert_eq!(
            std::fs::read_to_string(&hist).unwrap(),
            "a <- 1<\\n>b <- 2\n"
        );
        let store = tmp.path().join("console_history.folders");
        assert_eq!(store_path(&hist), Some(store));
        // A console started later reads it back.
        let again = FolderStore::beside(&hist);
        assert_eq!(
            suggestion(&again, Some(&d.a), "a <-").as_deref(),
            Some(" 1\nb <- 2")
        );
    }

    #[test]
    fn two_consoles_keep_each_others_entries() {
        let d = dirs();
        let tmp = tempfile::tempdir().unwrap();
        let hist = tmp.path().join("history");
        std::fs::write(&hist, "").unwrap();
        let one = FolderStore::beside(&hist);
        let two = FolderStore::beside(&hist);
        one.record(Some(&d.a), "from_one");
        two.record(Some(&d.a), "from_two");
        one.sync().unwrap();
        two.sync().unwrap();
        let three = FolderStore::beside(&hist);
        assert_eq!(
            suggestion(&three, Some(&d.a), "from_o").as_deref(),
            Some("ne")
        );
        assert_eq!(
            suggestion(&three, Some(&d.a), "from_t").as_deref(),
            Some("wo")
        );
    }

    #[test]
    fn a_relative_history_file_gets_an_absolute_store() {
        let path = store_path(Path::new("hist/console_history")).unwrap();
        assert!(path.is_absolute(), "{path:?}");
        assert!(path.ends_with("hist/console_history.folders"));
    }

    #[test]
    fn no_store_on_disk_without_a_history_file_on_disk() {
        let tmp = tempfile::tempdir().unwrap();
        // The main history could not be created (e.g. a read-only folder).
        let missing = tmp.path().join("missing");
        assert!(FolderStore::beside(&missing).file.is_none());
        assert!(!store_path(&missing).unwrap().exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_history_sent_to_dev_null_keeps_no_store() {
        let d = dirs();
        let tmp = tempfile::tempdir().unwrap();
        let hist = tmp.path().join("history");
        std::os::unix::fs::symlink("/dev/null", &hist).unwrap();
        let store = FolderStore::beside(&hist);
        assert!(store.file.is_none());
        store.record(Some(&d.a), "secret <- 1");
        store.sync().unwrap();
        assert!(!store_path(&hist).unwrap().exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_store_is_private_even_when_recreated() {
        let d = dirs();
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let hist = tmp.path().join("history");
        std::fs::write(&hist, "").unwrap();
        let file = store_path(&hist).unwrap();
        let mode = || std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        let store = FolderStore::beside(&hist);
        assert_eq!(mode(), 0o600);
        // Cleared (the file is removed), then written again.
        store.clear().unwrap();
        store.record(Some(&d.a), "x <- 1");
        store.sync().unwrap();
        assert_eq!(mode(), 0o600);
        // Deleted while the console runs.
        std::fs::remove_file(&file).unwrap();
        store.record(Some(&d.a), "y <- 1");
        store.sync().unwrap();
        assert_eq!(mode(), 0o600);
    }
}
