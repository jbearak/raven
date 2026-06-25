//! Content-addressed identity for an `Arc<str>`.
//!
//! Used as the memoization key for per-file `RFileFacts` in `derive_package_state`.

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Default)]
pub struct ContentDigest {
    pub byte_len: u32,
    pub blake3_prefix: u64,
}

impl ContentDigest {
    pub fn of(text: &str) -> Self {
        Self::of_bytes(text.as_bytes())
    }

    pub fn of_bytes(data: &[u8]) -> Self {
        let hash = blake3::hash(data);
        let bytes = hash.as_bytes();
        let blake3_prefix = u64::from_le_bytes(bytes[..8].try_into().unwrap());
        Self {
            byte_len: u32::try_from(data.len()).unwrap_or(u32::MAX),
            blake3_prefix,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_text_yields_equal_digest() {
        assert_eq!(
            ContentDigest::of("foo <- 1\n"),
            ContentDigest::of("foo <- 1\n")
        );
    }

    #[test]
    fn different_text_yields_different_digest() {
        assert_ne!(
            ContentDigest::of("foo <- 1\n"),
            ContentDigest::of("foo <- 2\n")
        );
    }

    #[test]
    fn empty_text_has_zero_length() {
        assert_eq!(ContentDigest::of("").byte_len, 0);
    }
}
