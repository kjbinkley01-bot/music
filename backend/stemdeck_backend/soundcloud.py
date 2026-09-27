"""Optional SoundCloud integration using only the official API.

* OAuth 2.1 (authorization code + PKCE) sign-in.
* Reads your likes and playlists as metadata only, to build a wishlist with links to buy tracks.
* Uploads a finished remix file to your own account.

Audio streams are never requested, downloaded or cached. Everything else in StemDeck works
without this module being configured.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import urlencode

from .config import DATA_DIR, settings
from .db import db

AUTH_URL = "https://secure.soundcloud.com/authorize"
TOKEN_URL = "https://secure.soundcloud.com/oauth/token"
API = "https://api.soundcloud.com"
TOKEN_PATH = DATA_DIR / "soundcloud_token.json"


class SoundCloudError(RuntimeError):
    pass


class SoundCloud:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pending: dict[str, tuple[str, float]] = {}  # state -> (code_verifier, created)
        self.redirect_uri = ""

    # ---- configuration --------------------------------------------------------

    def configured(self) -> bool:
        return bool(settings.get("soundcloud_client_id") and settings.get("soundcloud_client_secret"))

    def _token(self) -> dict | None:
        try:
            return json.loads(TOKEN_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _save_token(self, token: dict) -> None:
        token["obtained_at"] = time.time()
        TOKEN_PATH.write_text(json.dumps(token), encoding="utf-8")

    def status(self) -> dict:
        token = self._token()
        return {
            "configured": self.configured(),
            "connected": bool(token),
            "username": (token or {}).get("username", ""),
            "redirect_uri": self.redirect_uri,
        }

    def disconnect(self) -> None:
        TOKEN_PATH.unlink(missing_ok=True)

    # ---- OAuth ----------------------------------------------------------------

    def authorize_url(self) -> str:
        if not self.configured():
            raise SoundCloudError("Add your SoundCloud client ID and secret in Settings first")
        verifier = secrets.token_urlsafe(64)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = secrets.token_urlsafe(24)
        with self._lock:
            now = time.time()
            self._pending = {k: v for k, v in self._pending.items() if now - v[1] < 600}
            self._pending[state] = (verifier, now)
        return AUTH_URL + "?" + urlencode({
            "client_id": settings.get("soundcloud_client_id"),
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
        })

    def complete(self, code: str, state: str) -> None:
        with self._lock:
            pending = self._pending.pop(state, None)
        if not pending:
            raise SoundCloudError("Sign-in expired or was not started from StemDeck. Please try again.")
        token = self._token_request({
            "grant_type": "authorization_code",
            "redirect_uri": self.redirect_uri,
            "code_verifier": pending[0],
            "code": code,
        })
        self._save_token(token)
        me = self._get("/me")
        token["username"] = me.get("username", "")
        self._save_token(token)

    def _token_request(self, data: dict) -> dict:
        import httpx

        data = {**data, "client_id": settings.get("soundcloud_client_id"),
                "client_secret": settings.get("soundcloud_client_secret")}
        r = httpx.post(TOKEN_URL, data=data, headers={"accept": "application/json; charset=utf-8"}, timeout=30)
        if r.status_code != 200:
            raise SoundCloudError(f"SoundCloud token request failed ({r.status_code}): {r.text[:200]}")
        return r.json()

    def _access_token(self) -> str:
        token = self._token()
        if not token:
            raise SoundCloudError("Not connected to SoundCloud")
        expires = token.get("obtained_at", 0) + float(token.get("expires_in", 3600)) - 60
        if time.time() > expires and token.get("refresh_token"):
            username = token.get("username", "")
            token = self._token_request({"grant_type": "refresh_token", "refresh_token": token["refresh_token"]})
            token["username"] = username
            self._save_token(token)
        return token["access_token"]

    # ---- API ------------------------------------------------------------------

    def _get(self, path_or_url: str, params: dict | None = None) -> dict:
        import httpx

        url = path_or_url if path_or_url.startswith("http") else API + path_or_url
        r = httpx.get(url, params=params, timeout=30,
                      headers={"Authorization": f"OAuth {self._access_token()}", "accept": "application/json"})
        if r.status_code != 200:
            raise SoundCloudError(f"SoundCloud API error ({r.status_code}): {r.text[:200]}")
        return r.json()

    def _paged(self, path: str, params: dict, limit_pages: int = 10) -> list[dict]:
        items: list[dict] = []
        page = self._get(path, {**params, "linked_partitioning": "true", "limit": 50})
        for _ in range(limit_pages):
            items.extend(page.get("collection", []))
            nxt = page.get("next_href")
            if not nxt:
                break
            page = self._get(nxt)
        return items

    def likes(self) -> list[dict]:
        return [_track_summary(t) for t in self._paged("/me/likes/tracks", {}) if t.get("kind", "track") == "track"]

    def playlists(self) -> list[dict]:
        out = []
        for pl in self._paged("/me/playlists", {"show_tracks": "true"}, limit_pages=4):
            out.append({
                "id": pl.get("id"),
                "title": pl.get("title", ""),
                "tracks": [_track_summary(t) for t in pl.get("tracks", []) if t.get("title")],
            })
        return out

    def upload(self, path: Path, title: str, sharing: str = "private", description: str = "") -> dict:
        import httpx

        with path.open("rb") as fh:
            r = httpx.post(
                API + "/tracks",
                headers={"Authorization": f"OAuth {self._access_token()}", "accept": "application/json"},
                data={"track[title]": title, "track[sharing]": sharing, "track[description]": description},
                files={"track[asset_data]": (path.name, fh)},
                timeout=None,
            )
        if r.status_code not in (200, 201):
            raise SoundCloudError(f"Upload failed ({r.status_code}): {r.text[:200]}")
        data = r.json()
        return {"id": data.get("id"), "permalink_url": data.get("permalink_url")}


def _track_summary(t: dict) -> dict:
    return {
        "sc_id": t.get("id"),
        "title": t.get("title", ""),
        "artist": (t.get("user") or {}).get("username", ""),
        "permalink_url": t.get("permalink_url"),
        "purchase_url": t.get("purchase_url"),
        "artwork_url": t.get("artwork_url"),
        "bpm": t.get("bpm"),
    }


def add_to_wishlist(items: list[dict], source: str) -> int:
    added = 0
    for it in items:
        if not it.get("title"):
            continue
        cur = db.execute(
            "INSERT OR IGNORE INTO wishlist (sc_id, title, artist, permalink_url, purchase_url, artwork_url, bpm,"
            " source, added_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (it.get("sc_id"), it["title"], it.get("artist", ""), it.get("permalink_url"), it.get("purchase_url"),
             it.get("artwork_url"), it.get("bpm"), source, time.time()),
        )
        added += cur.rowcount
    return added


soundcloud = SoundCloud()
