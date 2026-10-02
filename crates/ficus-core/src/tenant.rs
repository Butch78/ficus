//! Tenants: every tree belongs to one, and every name a tree creates (its
//! Durable Object, its Artifacts repos, its containers) starts with the
//! tenant's key, so two tenants can both own a tree called `site`.
//!
//! The key is derived by the public edge from the organization's id, which
//! it has already authorized the caller against; this crate only checks its
//! shape. The edge is the only way in, so a well-formed key is a trusted one.

use serde::{Deserialize, Serialize};

/// Length of a tenant key: 10 base32 characters, 50 bits.
pub const TENANT_KEY_LEN: usize = 10;

/// The header the edge sets on every request it forwards.
pub const TENANT_HEADER: &str = "x-ficus-tenant";

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct TenantKey(String);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("not a tenant key: {0:?} (expected {TENANT_KEY_LEN} characters of a-z and 2-7)")]
pub struct MalformedTenantKey(pub String);

impl TenantKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The name of a tenant's tree, as its Durable Object and root repo know it.
    pub fn scope(&self, tree: &str) -> String {
        format!("{}-{tree}", self.0)
    }
}

impl TryFrom<String> for TenantKey {
    type Error = MalformedTenantKey;

    fn try_from(key: String) -> Result<Self, Self::Error> {
        let base32 = |b: u8| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b);
        if key.len() == TENANT_KEY_LEN && key.bytes().all(base32) {
            Ok(Self(key))
        } else {
            Err(MalformedTenantKey(key))
        }
    }
}

impl From<TenantKey> for String {
    fn from(key: TenantKey) -> Self {
        key.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_lowercase_base32_of_the_right_length() {
        let key = TenantKey::try_from("abcdefgh27".to_owned()).unwrap();
        assert_eq!(key.scope("site"), "abcdefgh27-site");
    }

    #[test]
    fn rejects_anything_else() {
        for bad in [
            "abcdefgh2",
            "abcdefgh278",
            "ABCDEFGH27",
            "abcdefgh18",
            "abcd-fgh27",
            "",
        ] {
            assert_eq!(
                TenantKey::try_from(bad.to_owned()),
                Err(MalformedTenantKey(bad.to_owned())),
                "{bad}"
            );
        }
    }
}
