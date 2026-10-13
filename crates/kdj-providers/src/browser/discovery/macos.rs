use super::{candidate, InstalledBrowser};
use objc2::{rc::Retained, runtime::NSObjectProtocol, sel};
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSArray, NSBundle, NSString, NSURL};
use std::path::PathBuf;

pub(super) fn discover() -> Vec<InstalledBrowser> {
    objc2::rc::autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let mut browsers = Vec::new();
        // Query both schemes: registrations need not be identical. This only queries Launch Services.
        for scheme in ["https://example.invalid/", "http://example.invalid/"] {
            let Some(url) = NSURL::URLWithString(&NSString::from_str(scheme)) else {
                continue;
            };
            let applications = applications_for_url(&workspace, &url);
            for index in 0..applications.count() {
                let app = applications.objectAtIndex(index);
                let Some(path) = app.path() else { continue };
                let Some(bundle) = NSBundle::bundleWithURL(&app) else {
                    continue;
                };
                if !bundle
                    .executableURL()
                    .and_then(|url| url.path())
                    .is_some_and(|path| PathBuf::from(path.to_string()).is_file())
                {
                    continue;
                }
                let bundle_id = bundle
                    .bundleIdentifier()
                    .map(|id| id.to_string())
                    .unwrap_or_default();
                let path = PathBuf::from(path.to_string());
                let label = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                if let Some(browser) = candidate(label, path, adapter(&bundle_id)) {
                    browsers.push(browser);
                }
            }
        }
        browsers
    })
}

fn applications_for_url(workspace: &NSWorkspace, url: &NSURL) -> Retained<NSArray<NSURL>> {
    if workspace.respondsToSelector(sel!(URLsForApplicationsToOpenURL:)) {
        return workspace.URLsForApplicationsToOpenURL(url);
    }
    // KDJ also supports macOS 10.15–11; the NSWorkspace method was added in 12.
    // The older API has the same discovery semantics and is available since 10.3.
    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn LSCopyApplicationURLsForURL(
            url: *const std::ffi::c_void,
            roles: u32,
        ) -> *mut std::ffi::c_void;
    }
    // NSURL/CFURL and NSArray/CFArray are toll-free bridged. The Copy function returns
    // an owned reference, transferred to Retained (and released once on drop).
    unsafe {
        Retained::from_raw(
            LSCopyApplicationURLsForURL((url as *const NSURL).cast(), u32::MAX).cast(),
        )
        .unwrap_or_else(NSArray::new)
    }
}

fn adapter(bundle: &str) -> Option<&'static str> {
    // Exact identities: a similarly named app or a development channel must not inherit
    // another browser's profile directory or keychain identity.
    Some(match bundle {
        "company.thebrowser.Browser" => "arc",
        "com.google.Chrome" => "chrome",
        "com.microsoft.edgemac" => "edge",
        "org.mozilla.firefox" => "firefox",
        "com.brave.Browser" => "brave",
        "org.chromium.Chromium" => "chromium",
        "com.vivaldi.Vivaldi" => "vivaldi",
        "com.operasoftware.Opera" => "opera",
        "com.operasoftware.OperaGX" => "opera_gx",
        "app.zen-browser.zen" => "zen",
        "io.gitlab.librewolf-community" => "librewolf",
        "com.apple.Safari" => "safari",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn channels_and_unknown_apps_do_not_inherit_stable_profiles() {
        assert_eq!(adapter("com.google.Chrome"), Some("chrome"));
        assert_eq!(adapter("com.google.Chrome.canary"), None);
        assert_eq!(adapter("example.Chrome"), None);
    }

    #[test]
    #[ignore = "read-only native discovery smoke test; run explicitly on macOS"]
    fn system_discovery_smoke() {
        let browsers = crate::browser::discovery::installed();
        assert!(!browsers.is_empty());
        for browser in browsers {
            assert!(browser.executable.is_dir());
            eprintln!(
                "{}: adapter={:?}, authorization={}",
                browser.label, browser.adapter_id, browser.authorization_supported
            );
        }
    }
}
