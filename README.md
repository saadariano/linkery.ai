# WebMark bookmark sync server

WebMark 1.30.5 can sync bookmarks and folders via a separate HTTPS service. It encrypts records before sending them. Devices use the existing Google sign-in and the same sync passphrase. The web page and extension poll while open, and Android checks while the WebMark screen is active. Pending edits sync when WebMark reconnects. Notes and passwords retain their existing sync.

## Host the service

Run with Node 24 or newer. Place the database on a persistent volume and keep a backup. Use a TLS reverse proxy and a process supervisor so the service remains available after logout or restart.

```sh
WEBMARK_FIREBASE_PROJECT=webmark-529a9 WEBMARK_SYNC_DB=/persistent/webmark.sqlite node server.mjs
```

The service listens on 127.0.0.1:8080 by default. Point your HTTPS reverse proxy at that address. For example, a Caddy site block can contain `reverse_proxy 127.0.0.1:8080`. Check `/health` on your public HTTPS origin. Keep the URL to one origin, without a path or a trailing redirect.

## Prepare the release

If you want older cloud bookmarks included, first finish syncing them in 1.30.4 on at least one device. Keep that device's existing local data when updating. The service starts with an empty database and the first device uploads the bookmarks it has locally.

Run the configurator on the GitHub Pages ZIP and any browser extensions you plan to use.

```sh
python3 configure-release.py https://sync.example.com WebMark-GitHub-Publish-1.30.5.zip WebMark-Chrome-Edge-Extension-1.30.5.zip WebMark-Firefox-Extension-1.30.5.zip
```

Publish the configured GitHub Pages ZIP to the existing WebMark site at saadariano.github.io/linkery.ai. The included Android APK reads the bookmark server address from that site's configuration. Open the updated website or the APK, then open Sync Center and tap Sync beside Bookmarks once. Enter a sync passphrase with at least 16 characters. Repeat on each device with exactly the same passphrase. Load the configured extension build to connect the extension dashboard.

Keep the passphrase with your encrypted backup. The server cannot recover it. Google sign-in still uses WebMark's existing authentication system. The bookmark service does not make Firestore requests. Notes, passwords, and any legacy sign-in handoff continue to use the existing integrations.
