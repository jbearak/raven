//! Layer-merge raw client settings + raw project settings into a single
//! JSON tree suitable for the existing `parse_*_config` functions.
//!
//! Merge semantics: deep-merge objects; project values overwrite client
//! values at the leaf level; arrays are taken whole (no element-level merge).

use serde_json::Value;

/// Merge `project` into a clone of `client`. The result has every key from
/// either layer; conflicting leaves prefer `project`. Arrays at the same
/// path are replaced by the project version (no concatenation).
pub fn merge(client: &Value, project: Option<&Value>) -> Value {
    let mut out = client.clone();
    if let Some(p) = project {
        merge_into(&mut out, p);
    }
    out
}

/// In-place variant used by callers that already own a mutable destination.
/// `src` wins at leaves; objects merge recursively; arrays/scalars replace.
pub fn merge_into(dst: &mut Value, src: &Value) {
    match (dst, src) {
        (Value::Object(dst_map), Value::Object(src_map)) => {
            for (k, v) in src_map {
                match dst_map.get_mut(k) {
                    Some(existing) => merge_into(existing, v),
                    None => {
                        dst_map.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (slot, src_val) => {
            *slot = src_val.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn project_overrides_client_at_leaf() {
        let client = json!({ "linting": { "lineLength": 80 } });
        let project = json!({ "linting": { "lineLength": 120 } });
        assert_eq!(
            merge(&client, Some(&project)),
            json!({ "linting": { "lineLength": 120 } })
        );
    }

    #[test]
    fn client_key_passes_through_when_project_silent() {
        let client = json!({ "linting": { "objectLength": 40 } });
        let project = json!({ "linting": { "lineLength": 100 } });
        let merged = merge(&client, Some(&project));
        assert_eq!(merged["linting"]["objectLength"], json!(40));
        assert_eq!(merged["linting"]["lineLength"], json!(100));
    }

    #[test]
    fn unrelated_sections_coexist() {
        let client = json!({ "packages": { "rPath": "/usr/bin/R" } });
        let project = json!({ "linting": { "enabled": true } });
        let merged = merge(&client, Some(&project));
        assert_eq!(merged["packages"]["rPath"], json!("/usr/bin/R"));
        assert_eq!(merged["linting"]["enabled"], json!(true));
    }

    #[test]
    fn arrays_are_replaced_wholesale() {
        let client = json!({ "packages": { "additionalLibraryPaths": ["/a"] } });
        let project = json!({ "packages": { "additionalLibraryPaths": ["/b", "/c"] } });
        let merged = merge(&client, Some(&project));
        assert_eq!(
            merged["packages"]["additionalLibraryPaths"],
            json!(["/b", "/c"])
        );
    }

    #[test]
    fn project_none_yields_client_clone() {
        let client = json!({ "linting": { "enabled": true } });
        assert_eq!(merge(&client, None), client);
    }

    #[test]
    fn client_null_yields_project_clone() {
        let project = json!({ "linting": { "enabled": true } });
        assert_eq!(merge(&Value::Null, Some(&project)), project);
    }
}
