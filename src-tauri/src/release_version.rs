use semver::{Prerelease, Version};

/// Keep the published rcN naming scheme while comparing its sequence numerically.
fn normalized(version: &Version) -> Version {
    let mut version = version.clone();
    for stage in ["alpha", "beta", "rc"] {
        let Some(sequence) = version.pre.as_str().strip_prefix(stage) else {
            continue;
        };
        if !sequence.is_empty() && sequence.bytes().all(|byte| byte.is_ascii_digit()) {
            if let Ok(pre) = Prerelease::new(&format!("{stage}.{sequence}")) {
                version.pre = pre;
            }
        }
        break;
    }
    version
}

pub fn is_newer(current: &Version, candidate: &Version) -> bool {
    normalized(candidate) > normalized(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rc_sequence_crosses_digit_boundaries_without_downgrading() {
        for (current, candidate, expected) in [
            ("1.0.0-rc9", "1.0.0-rc10", true),
            ("1.0.0-rc10", "1.0.0-rc9", false),
            ("1.0.0-rc19", "1.0.0-rc20", true),
            ("1.0.0-rc10", "1.0.0-rc10", false),
            ("1.0.0-rc10", "1.0.0-rc.10", false),
            ("1.0.0-rc10", "1.0.0", true),
            ("1.0.0", "1.0.0-rc10", false),
            ("1.0.0-rc10", "0.9.9", false),
            ("1.0.0-rc10", "1.0.1-rc1", true),
        ] {
            assert_eq!(
                is_newer(&current.parse().unwrap(), &candidate.parse().unwrap()),
                expected,
                "{current} -> {candidate}"
            );
        }
    }
}
