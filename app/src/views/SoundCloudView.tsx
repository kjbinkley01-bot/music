import { useCallback, useEffect, useState } from 'react';
import { type ScTrack, api } from '../api';
import { IconExternal, IconTrash } from '../components/Icons';
import { reportError, useApp } from '../store/app';

type ScStatus = Awaited<ReturnType<typeof api.scStatus>>;
type WishItem = Awaited<ReturnType<typeof api.wishlist>>[number];

function open(url: string | null) {
  if (!url) return;
  if (window.stemdeck) void window.stemdeck.openExternal(url);
  else window.open(url, '_blank');
}

function TrackRow({ t, action }: { t: ScTrack; action?: React.ReactNode }) {
  return (
    <tr>
      <td style={{ width: 44 }}>{t.artwork_url ? <img src={t.artwork_url} width={34} height={34} style={{ borderRadius: 6, display: 'block' }} alt="" /> : null}</td>
      <td className="ellipsis" style={{ maxWidth: 280 }}>
        {t.title}
      </td>
      <td className="muted ellipsis" style={{ maxWidth: 160 }}>
        {t.artist}
      </td>
      <td style={{ textAlign: 'right' }}>
        <span className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
          {t.purchase_url && (
            <button className="btn sm primary" onClick={() => open(t.purchase_url)}>
              Buy <IconExternal size={11} />
            </button>
          )}
          {t.permalink_url && (
            <button className="btn sm" onClick={() => open(t.permalink_url)} title="Open on SoundCloud">
              SoundCloud <IconExternal size={11} />
            </button>
          )}
          {t.title && (
            <button className="btn sm" onClick={() => open(`https://www.beatport.com/search?q=${encodeURIComponent(`${t.artist} ${t.title}`)}`)} title="Search Beatport">
              Beatport
            </button>
          )}
          {t.title && (
            <button className="btn sm" onClick={() => open(`https://bandcamp.com/search?q=${encodeURIComponent(`${t.artist} ${t.title}`)}`)} title="Search Bandcamp">
              Bandcamp
            </button>
          )}
          {action}
        </span>
      </td>
    </tr>
  );
}

export function SoundCloudView() {
  const [status, setStatus] = useState<ScStatus | null>(null);
  const [likes, setLikes] = useState<ScTrack[] | null>(null);
  const [playlists, setPlaylists] = useState<{ id: number; title: string; tracks: ScTrack[] }[] | null>(null);
  const [wishlist, setWishlist] = useState<WishItem[]>([]);
  const [busy, setBusy] = useState(false);
  const settings = useApp((s) => s.settings);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.scStatus());
      setWishlist(await api.wishlist());
    } catch (e) {
      reportError(e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, settings?.soundcloud_client_id]);

  // After the browser sign-in finishes, the callback lands on the engine; poll until connected.
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(async () => {
      const s = await api.scStatus();
      if (s.connected) {
        setStatus(s);
        setBusy(false);
      }
    }, 1500);
    const stop = window.setTimeout(() => setBusy(false), 180000);
    return () => {
      clearInterval(id);
      clearTimeout(stop);
    };
  }, [busy]);

  const load = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      reportError(e, 'SoundCloud');
    }
  };

  const addAll = async (items: ScTrack[], source: string) => {
    await load(async () => {
      const r = await api.wishlistAdd(items, source);
      useApp.getState().toast(`Added ${r.added} to your wishlist`, 'success');
      setWishlist(await api.wishlist());
    });
  };

  if (!status) return null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, height: '100%' }}>
      <div className="glass panel">
        <div className="panel-head">
          <span className="panel-title">SoundCloud</span>
          <div className="spacer" />
          {status.connected ? (
            <>
              <span className="chip ok">Connected as {status.username || 'you'}</span>
              <button className="btn sm ghost" onClick={() => void api.scDisconnect().then(refresh)}>
                Disconnect
              </button>
            </>
          ) : null}
        </div>
        <div className="panel-body" style={{ padding: 16 }}>
          {!status.configured ? (
            <SetupHelp redirect={status.redirect_uri} />
          ) : !status.connected ? (
            <div className="empty">
              <h3>Connect your SoundCloud account</h3>
              <div>StemDeck only reads your likes and playlists (titles and links) and can upload remixes you choose. It never downloads or caches audio.</div>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  load(async () => {
                    const { url } = await api.scAuthorize();
                    open(url);
                    setBusy(true);
                  })
                }
              >
                {busy ? 'Waiting for sign-in in your browser…' : 'Sign in with SoundCloud'}
              </button>
            </div>
          ) : (
            <div className="col" style={{ gap: 14 }}>
              <div className="row">
                <button className="btn" onClick={() => load(async () => setLikes(await api.scLikes()))}>
                  Load my likes
                </button>
                <button className="btn" onClick={() => load(async () => setPlaylists(await api.scPlaylists()))}>
                  Load my playlists
                </button>
              </div>
              {likes && (
                <div>
                  <div className="row">
                    <b className="grow">Likes ({likes.length})</b>
                    <button className="btn sm" onClick={() => addAll(likes, 'Likes')}>
                      Add all to wishlist
                    </button>
                  </div>
                  <table className="table">
                    <tbody>
                      {likes.map((t) => (
                        <TrackRow key={t.sc_id} t={t} action={<button className="btn sm" onClick={() => addAll([t], 'Likes')}>+</button>} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {playlists?.map((pl) => (
                <div key={pl.id}>
                  <div className="row">
                    <b className="grow">
                      {pl.title} ({pl.tracks.length})
                    </b>
                    <button className="btn sm" onClick={() => addAll(pl.tracks, pl.title)}>
                      Add all to wishlist
                    </button>
                  </div>
                  <table className="table">
                    <tbody>
                      {pl.tracks.map((t) => (
                        <TrackRow key={t.sc_id} t={t} />
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              <div className="faint" style={{ fontSize: 11.5 }}>
                To upload a remix, export it in Remix Studio — an “Upload to SoundCloud” button appears once it’s rendered. Uploads are private by default.
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="glass panel">
        <div className="panel-head">
          <span className="panel-title">Wishlist</span>
          <span className="faint">{wishlist.length} tracks to buy</span>
        </div>
        <div className="panel-body">
          {wishlist.length === 0 ? (
            <div className="empty">Tracks you add from SoundCloud appear here with links to buy them. Once you own the files, import them in Stem Lab.</div>
          ) : (
            <table className="table">
              <tbody>
                {wishlist.map((w) => (
                  <TrackRow
                    key={w.id}
                    t={w}
                    action={
                      <button
                        className="btn sm ghost"
                        title="Remove"
                        onClick={() => void api.wishlistDelete(w.id).then(() => setWishlist(wishlist.filter((x) => x.id !== w.id)))}
                      >
                        <IconTrash size={12} />
                      </button>
                    }
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function SetupHelp({ redirect }: { redirect: string }) {
  const settings = useApp((s) => s.settings)!;
  const update = useApp((s) => s.updateSettings);
  return (
    <div className="col" style={{ gap: 14, maxWidth: 560 }}>
      <h3 style={{ margin: 0 }}>Optional: connect SoundCloud</h3>
      <div className="muted" style={{ lineHeight: 1.6 }}>
        SoundCloud requires every app to register for API access (an approval application). Everything else in StemDeck works without it.
        Once approved:
        <ol style={{ paddingLeft: 18 }}>
          <li>
            Create an app at <a href="https://soundcloud.com/you/apps" target="_blank" rel="noreferrer">soundcloud.com/you/apps</a>.
          </li>
          <li>
            Set its redirect URI to <code className="mono">{redirect}</code>
          </li>
          <li>Paste the client ID and secret below.</li>
        </ol>
      </div>
      <div className="form-grid" style={{ gridTemplateColumns: '120px 1fr' }}>
        <label>Client ID</label>
        <input className="input" value={settings.soundcloud_client_id} onChange={(e) => void update({ soundcloud_client_id: e.target.value.trim() })} />
        <label>Client secret</label>
        <input className="input" type="password" value={settings.soundcloud_client_secret} onChange={(e) => void update({ soundcloud_client_secret: e.target.value.trim() })} />
      </div>
    </div>
  );
}
