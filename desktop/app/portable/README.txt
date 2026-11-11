mapcro, portable (Windows)

Run mapcro.exe. Nothing is installed.

- Needs Microsoft Edge WebView2, which current Windows 10 and 11 already have.
  If the window stays blank, install the "Evergreen Runtime" from
  https://developer.microsoft.com/microsoft-edge/webview2/
- No automatic updates. When a newer version is out, the app shows
  "Update available": download the new zip from the release page.
- No Start-menu entry and no uninstaller. To remove it, delete this folder.
- It registers mapcro:// links for your Windows account on each start, so a
  board's "Open in app" opens here.
- Settings are kept in your profile, not in this folder: the replays folder
  you chose in %APPDATA%\com.dmgdeadlock.mapcro, the rest in
  %LOCALAPPDATA%\com.dmgdeadlock.mapcro.
- Unsigned beta: Windows may say "Windows protected your PC".
  More info, then Run anyway.

The installer (mapcro_x64-setup.exe) does all of this for you, and updates
itself: https://github.com/intendednull/mapcro/releases/latest
