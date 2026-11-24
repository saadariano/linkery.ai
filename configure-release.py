"""Set the HTTPS bookmark service on the website and browser extension ZIPs."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("origin", help="HTTPS origin, for example https://sync.example.com")
    parser.add_argument("packages", nargs="+", type=Path)
    args = parser.parse_args()
    origin = args.origin.rstrip("/")
    parsed = urlsplit(origin)
    if (
        parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
        or parsed.path or parsed.query or parsed.fragment or parsed.port is not None
        or any(char not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for char in parsed.hostname)
        or origin != "https://" + parsed.hostname
    ):
        parser.error("Enter a public HTTPS origin with no path or port.")

    for source in args.packages:
        dest = source.with_name(source.stem + "-Configured.zip")
        with ZipFile(source) as original:
            config = json.loads(original.read("cloud-config.json"))
            config["bookmarkSyncUrl"] = origin
            updated = {"cloud-config.json": json.dumps(config, indent=2) + "\n"}
            if "manifest.json" in original.namelist():
                manifest = json.loads(original.read("manifest.json"))
                manifest["host_permissions"].append(origin + "/*")
                csp = manifest["content_security_policy"]
                csp["extension_pages"] = csp["extension_pages"].replace(
                    "connect-src 'self'", "connect-src 'self' " + origin, 1
                )
                updated["manifest.json"] = json.dumps(manifest, indent=2) + "\n"
            with ZipFile(dest, "w", ZIP_DEFLATED) as configured:
                for name in original.namelist():
                    configured.writestr(name, updated[name] if name in updated else original.read(name))
        print(dest)


if __name__ == "__main__":
    main()
