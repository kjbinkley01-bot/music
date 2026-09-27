import io
import time

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from stemdeck_backend.app import app
from stemdeck_backend.config import settings


def wait_for(client, predicate, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        tracks = client.get("/tracks").json()
        if predicate(tracks):
            return tracks
        time.sleep(0.3)
    raise AssertionError("timed out")


def test_full_flow(click_track, tmp_path):
    settings.update({"output_dir": str(tmp_path / "out")})
    with TestClient(app) as client:
        assert client.get("/health").json()["ok"]

        res = client.post("/tracks/import", json={"paths": [str(click_track.parent), "/does/not/exist"]}).json()
        assert len(res["added"]) == 1 and res["missing"] == ["/does/not/exist"]
        # importing again is a no-op
        assert client.post("/tracks/import", json={"paths": [str(click_track)]}).json()["skipped"] == 1

        tracks = wait_for(client, lambda ts: ts and ts[0]["analysis_status"] != "pending")
        t = tracks[0]
        assert t["analysis_status"] == "done", t["error"]
        assert t["title"] == "Click Track" and t["artist"] == "Test Artist"
        assert abs(t["bpm"] - 124) < 0.5 and t["camelot"] in ("8A", "8B")

        # edit grid + cues
        patched = client.patch(f"/tracks/{t['id']}", json={"bpm": 124.0, "cues": [{"index": 0, "time": 1.5}]}).json()
        assert patched["cues"][0]["time"] == 1.5

        # audio streaming
        audio = client.get(f"/tracks/{t['id']}/audio")
        assert audio.status_code == 200 and len(audio.content) > 1000
        assert client.get(f"/tracks/{t['id']}/stems/vocals").status_code == 404

        # stretched rendering (used by remix clips)
        st = client.get(f"/tracks/{t['id']}/stretched", params={"ratio": 1.1, "semitones": 2})
        assert st.status_code == 200
        data, sr = sf.read(io.BytesIO(st.content))
        assert abs(len(data) / sr - 16 / 1.1) < 0.3

        # export without stems falls back to the original
        out = client.post("/export/stems", json={"track_id": t["id"], "gains": {"vocals": 1}, "format": "mp3",
                                                  "tempo_ratio": 1.0, "start": 1.0, "end": 5.0}).json()
        assert out["files"][0].endswith(".mp3")

        # rendered remix -> saved and added to library as a remix with preset analysis
        buf = io.BytesIO()
        sf.write(buf, np.zeros((44100, 2), dtype=np.float32), 44100, format="WAV")
        r = client.post("/export/render", params={"name": "My Remix", "format": "wav", "bpm": 126, "key_pc": 9,
                                                   "key_mode": "minor"}, content=buf.getvalue()).json()
        remix = client.get(f"/tracks/{r['track_id']}").json()
        assert remix["is_remix"] and remix["bpm"] == 126 and remix["camelot"] == "8A"

        # projects
        pid = client.post("/projects", json={"name": "P", "data": {"bpm": 120}}).json()["id"]
        client.put(f"/projects/{pid}", json={"name": "P2", "data": {"bpm": 121}})
        assert client.get(f"/projects/{pid}").json()["data"]["bpm"] == 121

        # recording
        client.post("/recording/start", json={"sample_rate": 48000, "channels": 2, "format": "wav", "name": "set"})
        client.post("/recording/chunk", content=np.zeros(9600, dtype="<i2").tobytes())
        rec = client.post("/recording/stop").json()["file"]
        info = sf.info(rec)
        assert info.samplerate == 48000 and info.frames == 4800

        # separation job for a track can be queued and cancelled
        job = client.post("/jobs/separate", json={"track_ids": [t["id"]], "quality": "fast"}).json()["jobs"][0]
        client.post(f"/jobs/{job}/cancel")
        # a running separation notices the cancel once its child process is up; allow for that
        end = time.time() + 60
        while time.time() < end:
            states = [j["status"] for j in client.get("/status").json()["jobs"] if j["id"] == job]
            if states and states[0] in ("canceled", "error", "done"):
                break
            time.sleep(0.3)
        assert states and states[0] == "canceled", states

        # soundcloud is optional and reports unconfigured
        assert client.get("/soundcloud/status").json()["configured"] is False
        assert client.get("/soundcloud/authorize").status_code == 400

        assert client.delete(f"/tracks/{t['id']}").json()["ok"]


def test_token_required(monkeypatch):
    import stemdeck_backend.app as appmod

    monkeypatch.setattr(appmod, "TOKEN", "secret")
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/tracks").status_code == 401
        assert client.get("/tracks", headers={"x-stemdeck-token": "secret"}).status_code == 200
