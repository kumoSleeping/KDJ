pub(crate) mod chromium;
pub(crate) mod mozilla;

#[cfg(all(target_os = "windows", feature = "internet-explorer"))]
pub(crate) mod internet_explorer;

#[cfg(target_os = "macos")]
pub(crate) mod safari;
