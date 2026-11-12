//! How the app was shipped (desktop/README.md, Installer or portable), and what that changes at
//! start. The installed app (NSIS, .deb, nix) is registered for `mapcro://` by its installer and
//! updates itself. The portable build (`--features portable`, the release's
//! `mapcro_<version>_x64-portable.zip`) has no installer: it registers the scheme for the current
//! user itself, and an update only shows as "Update available", a link to the new portable zip.
//! An AppImage is installed by nobody either, so it also registers itself; it updates itself.

/// How this copy was shipped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// An installer or a package put it there.
    Installed,
    /// The portable zip: a lone executable, run from wherever it was unpacked.
    Portable,
}

/// What to do with an update the feed offers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnUpdate {
    /// Download and install it (Windows: the installer runs passively and restarts the app).
    Install,
    /// Tell the page there is one; the user downloads the new zip from its link.
    Notify,
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

    pub const fn on_update(self) -> OnUpdate {
        match self {
            Mode::Installed => OnUpdate::Install,
            Mode::Portable => OnUpdate::Notify,
        }
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
    fn portable_registers_the_scheme_itself_and_only_notifies_of_updates() {
        assert!(Mode::Portable.registers_scheme(false));
        assert_eq!(Mode::Portable.on_update(), OnUpdate::Notify);
    }

    #[test]
    fn installed_leaves_both_to_the_installer_except_as_an_appimage() {
        assert!(!Mode::Installed.registers_scheme(false));
        assert!(Mode::Installed.registers_scheme(true));
        assert_eq!(Mode::Installed.on_update(), OnUpdate::Install);
    }

    #[test]
    fn updates_need_a_real_key() {
        assert!(!updates_on(""));
        assert!(!updates_on("  "));
        assert!(!updates_on("REPLACE_WITH_THE_MINISIGN_PUBLIC_KEY"));
        assert!(updates_on("dW50cnVzdGVkIGNvbW1lbnQ6"));
    }
}
