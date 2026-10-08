"""Validate the store ZIP against the installed Chrome bundle (stdlib only)."""
import json
from pathlib import Path
import stat
import sys
import zipfile

archive, bundle = Path(sys.argv[1]), Path(sys.argv[2])
expected = sorted(p.relative_to(bundle).as_posix() for p in bundle.rglob("*") if p.is_file())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None, "ZIP CRC check failed"
    assert z.namelist() == expected, "ZIP must contain exactly the sorted Chrome bundle at its root"
    manifest = json.loads(z.read("manifest.json"))
    assert manifest == json.loads((bundle / "manifest.json").read_text())
    assert "browser_specific_settings" not in manifest, "Firefox manifest in Chrome ZIP"
    for info in z.infolist():
        assert info.date_time == (1980, 1, 1, 0, 0, 0), "Non-normalized ZIP timestamp"
        assert not info.extra, "Host-specific ZIP extra fields"
        assert stat.S_IMODE(info.external_attr >> 16) == 0o644, "Non-normalized ZIP mode"
        assert z.read(info) == (bundle / info.filename).read_bytes(), info.filename
    for file in manifest["icons"].values():
        assert file in z.namelist(), f"Missing icon: {file}"
print("Chrome Web Store ZIP root, contents, icons and reproducible metadata verified.")
