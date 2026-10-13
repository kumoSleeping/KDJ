//! Inspect runtime files in registered browser installations, not marketing names.
//! This grants only a fresh-profile protocol attempt; never another product's saved-profile paths.
use super::BrowserEngine;
use std::path::Path;

pub(super) fn detect_macos(bundle: &Path) -> Option<BrowserEngine> {
    let native = bundle.join("Contents/MacOS");
    let gecko = native.join("XUL").is_file() && native.join("libmozglue.dylib").is_file();
    // Chromium forks rename their framework. The shared runtime resources retain their names.
    let chromium = std::fs::read_dir(bundle.join("Contents/Frameworks"))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .take(128)
        .any(|entry| {
            if entry
                .path()
                .extension()
                .is_none_or(|ext| ext != "framework")
            {
                return false;
            }
            [
                entry.path().join("Resources"),
                entry.path().join("Versions/Current/Resources"),
            ]
            .iter()
            .any(|root| root.join("icudtl.dat").is_file() && root.join("resources.pak").is_file())
        });
    match (gecko, chromium) {
        (true, false) => Some(BrowserEngine::Gecko),
        (false, true) => Some(BrowserEngine::Chromium),
        _ => None,
    }
}

pub(super) fn detect(executable: &Path) -> Option<BrowserEngine> {
    let root = executable.parent()?;
    let gecko = root.join("xul.dll").is_file() && root.join("mozglue.dll").is_file();
    let chromium = root.join("chrome.dll").is_file()
        || std::fs::read_dir(root)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .take(128)
            .any(|entry| {
                // Chrome/Edge/Opera commonly place the runtime inside a version directory.
                let name = entry.file_name();
                let name = name.to_string_lossy();
                !name.is_empty()
                    && name.bytes().all(|b| b.is_ascii_digit() || b == b'.')
                    && entry.path().join("chrome.dll").is_file()
            });
    match (gecko, chromium) {
        (true, false) => Some(BrowserEngine::Gecko),
        (false, true) => Some(BrowserEngine::Chromium),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn macos_forks_are_identified_by_runtime_not_bundle_name() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("Mystery.app");
        let native = bundle.join("Contents/MacOS");
        std::fs::create_dir_all(&native).unwrap();
        std::fs::write(native.join("XUL"), []).unwrap();
        assert_eq!(detect_macos(&bundle), None);
        std::fs::write(native.join("libmozglue.dylib"), []).unwrap();
        assert_eq!(detect_macos(&bundle), Some(BrowserEngine::Gecko));
        let resources = bundle.join("Contents/Frameworks/Mystery Framework.framework/Resources");
        std::fs::create_dir_all(&resources).unwrap();
        for name in ["icudtl.dat", "resources.pak"] {
            std::fs::write(resources.join(name), []).unwrap();
        }
        assert_eq!(detect_macos(&bundle), None);
        std::fs::remove_file(native.join("XUL")).unwrap();
        assert_eq!(detect_macos(&bundle), Some(BrowserEngine::Chromium));
    }
    #[test]
    fn engines_are_independent_of_browser_and_channel_names() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("unusual-browser.exe");
        assert_eq!(detect(&executable), None);
        std::fs::write(root.path().join("xul.dll"), []).unwrap();
        assert_eq!(detect(&executable), None);
        std::fs::write(root.path().join("mozglue.dll"), []).unwrap();
        assert_eq!(detect(&executable), Some(BrowserEngine::Gecko));
        let version = root.path().join("144.0.1234.0");
        std::fs::create_dir(&version).unwrap();
        std::fs::write(version.join("chrome.dll"), []).unwrap();
        assert_eq!(
            detect(&executable),
            None,
            "ambiguous runtime must not be guessed"
        );
        std::fs::remove_file(root.path().join("xul.dll")).unwrap();
        assert_eq!(detect(&executable), Some(BrowserEngine::Chromium));
    }
}
