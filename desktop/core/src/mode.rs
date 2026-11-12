//! How the app was shipped (desktop/README.md, Installer or portable), and what that changes at
//! start. The installed app (NSIS, .deb, nix) is registered for `mapcro://` by its installer. The
//! portable build (`--features portable`, the release's `mapcro_<version>_x64-portable.zip`) has no
//! installer: it registers the scheme for the current user itself. An AppImage is installed by
//! nobody either, so it also registers itself.
//!
//! Updates (desktop/README.md, Updates; operator, 2026-11-11, issue #43): nothing installs, closes
//! or restarts the app without the user's click. When the feed has a newer version, the page shows
//! "Update available": with **Install** where the updater can replace this copy (the Windows
//! installer, the AppImage), as a link to the new zip in the portable build, and not at all for a
//! package the system's package manager owns (the .deb, nix).

use serde::Serialize;

/// How this copy was shipped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// An installer or a package put it there.
    Installed,
    /// The portable zip: a lone executable, run from wherever it was unpacked.
    Portable,
}

/// The package this binary came in (Tauri's bundle type, stamped into the binary by the bundler),
/// as far as updates care.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Package {
    /// The NSIS installer (Windows).
    Nsis,
    /// An AppImage (Linux): the updater replaces the file.
    AppImage,
    /// A .deb (and the nix package, built from it): the package manager updates it.
    Deb,
    /// Any other bundle, or a release build no bundler stamped.
    Other,
    /// A debug build straight from cargo (the smoke test): offered as the installer is.
    Unbundled,
}

/// What the page offers for a newer version (`app_update`'s `kind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Offer {
    /// "Update available" with Install: the app downloads and installs it on the click, then
    /// restarts (Windows: the installer runs passively and starts the app again).
    Install,
    /// "Update available", a link to the new portable zip; the user unzips it.
    Link,
}

impl Mode {
    /// Fixed at build time: the `portable` cargo feature (`app/Cargo.toml`).
    pub const fn of_build(portable: bool) -> Self {
        if portable { Mode::Portable } else { Mode::Installed }
    }

    /// Whether the app registers `mapcro://` itself at start (the deep-link plugin's
    /// `register_all`), rather than relying on its installer. `appimage`: running as an
    /// AppImage (Linux).
    pub const fn registers_scheme(self, appimage: bool) -> bool {
        matches!(self, Mode::Portable) || appimage
    }

    /// What this copy offers when the feed has a newer version, if anything. Never an install
    /// without a click: `Install` only puts the button up.
    pub const fn offer(self, package: Package) -> Option<Offer> {
        match (self, package) {
            (Mode::Portable, _) => Some(Offer::Link),
            (Mode::Installed, Package::Nsis | Package::AppImage | Package::Unbundled) => Some(Offer::Install),
            (Mode::Installed, Package::Deb | Package::Other) => None,
        }
    }
}

/// Whether Install may go ahead: only where this copy offers Install, and only for the version
/// the feed offered this run (`offered`), which the page names back (`asked`). Else a reason code.
pub fn may_install(offer: Option<Offer>, offered: Option<&str>, asked: &str) -> Result<(), &'static str> {
    if offer != Some(Offer::Install) {
        return Err("no_update");
    }
    match offered {
        Some(v) if v == asked => Ok(()),
        _ => Err("no_update"),
    }
}

/// Updates are off while the updater's public key is missing or the placeholder
/// (desktop/README.md, Releasing).
pub fn updates_on(pubkey: &str) -> bool {
    !pubkey.trim().is_empty() && !pubkey.starts_with("REPLACE_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_build_flag_picks_the_mode() {
        assert_eq!(Mode::of_build(true), Mode::Portable);
        assert_eq!(Mode::of_build(false), Mode::Installed);
    }

    #[test]
    fn portable_registers_the_scheme_itself_and_only_links_to_updates() {
        assert!(Mode::Portable.registers_scheme(false));
        for p in [Package::Nsis, Package::AppImage, Package::Deb, Package::Other, Package::Unbundled] {
            assert_eq!(Mode::Portable.offer(p), Some(Offer::Link), "{p:?}");
        }
    }

    #[test]
    fn installed_leaves_the_scheme_to_the_installer_except_as_an_appimage() {
        assert!(!Mode::Installed.registers_scheme(false));
        assert!(Mode::Installed.registers_scheme(true));
    }

    #[test]
    fn the_installer_and_the_appimage_offer_install_and_a_package_offers_nothing() {
        assert_eq!(Mode::Installed.offer(Package::Nsis), Some(Offer::Install));
        assert_eq!(Mode::Installed.offer(Package::AppImage), Some(Offer::Install));
        assert_eq!(Mode::Installed.offer(Package::Unbundled), Some(Offer::Install));
        assert_eq!(Mode::Installed.offer(Package::Deb), None);
        assert_eq!(Mode::Installed.offer(Package::Other), None);
    }

    #[test]
    fn the_page_sees_the_offer_as_a_word() {
        assert_eq!(serde_json::to_string(&Offer::Install).expect("serialize"), "\"install\"");
        assert_eq!(serde_json::to_string(&Offer::Link).expect("serialize"), "\"link\"");
    }

    #[test]
    fn install_goes_ahead_only_for_the_offered_version_where_install_is_offered() {
        assert_eq!(may_install(Some(Offer::Install), Some("0.2.2"), "0.2.2"), Ok(()));
        // Another version than the feed offered, or none offered (up to date, not asked yet).
        assert_eq!(may_install(Some(Offer::Install), Some("0.2.2"), "0.2.3"), Err("no_update"));
        assert_eq!(may_install(Some(Offer::Install), Some("0.2.2"), ""), Err("no_update"));
        assert_eq!(may_install(Some(Offer::Install), None, "0.2.2"), Err("no_update"));
        // Portable links to the zip; a package is the package manager's.
        assert_eq!(may_install(Some(Offer::Link), Some("0.2.2"), "0.2.2"), Err("no_update"));
        assert_eq!(may_install(None, Some("0.2.2"), "0.2.2"), Err("no_update"));
    }

    #[test]
    fn updates_need_a_real_key() {
        assert!(!updates_on(""));
        assert!(!updates_on("  "));
        assert!(!updates_on("REPLACE_WITH_THE_MINISIGN_PUBLIC_KEY"));
        assert!(updates_on("dW50cnVzdGVkIGNvbW1lbnQ6"));
    }
}
