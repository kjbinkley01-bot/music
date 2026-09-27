import { useApp } from '../store/app';

export function SettingsView() {
  const settings = useApp((s) => s.settings);
  const health = useApp((s) => s.health);
  const update = useApp((s) => s.updateSettings);
  if (!settings) return null;
  const cores = navigator.hardwareConcurrency || 4;

  return (
    <div className="glass panel" style={{ height: '100%', maxWidth: 900, margin: '0 auto' }}>
      <div className="panel-head">
        <span className="panel-title">Settings</span>
      </div>
      <div className="panel-body" style={{ padding: 24 }}>
        <div className="form-grid">
          <div className="section-title">Output</div>
          <label>Export folder</label>
          <div className="row">
            <input className="input grow" value={settings.output_dir} onChange={(e) => void update({ output_dir: e.target.value })} />
            {window.stemdeck && (
              <>
                <button
                  className="btn"
                  onClick={async () => {
                    const dir = await window.stemdeck!.openFolder({ title: 'Choose export folder' });
                    if (dir) void update({ output_dir: dir });
                  }}
                >
                  Browse…
                </button>
                <button className="btn" onClick={() => void window.stemdeck!.openPath(settings.output_dir)}>
                  Open
                </button>
              </>
            )}
          </div>
          <div className="hint">Exports, rendered remixes and DJ recordings are saved in sub-folders here.</div>
          <label>MP3 bitrate</label>
          <select className="select" style={{ width: 160 }} value={settings.mp3_bitrate} onChange={(e) => void update({ mp3_bitrate: Number(e.target.value) })}>
            {[192, 256, 320].map((b) => (
              <option key={b} value={b}>
                {b} kbps
              </option>
            ))}
          </select>

          <div className="section-title">Stem separation</div>
          <label>Quality</label>
          <div className="seg">
            <button className={settings.quality === 'fast' ? 'on' : ''} onClick={() => void update({ quality: 'fast' })}>
              Fast
            </button>
            <button className={settings.quality === 'high' ? 'on' : ''} onClick={() => void update({ quality: 'high' })}>
              High quality
            </button>
          </div>
          <div className="hint">
            Fast uses Demucs <b>htdemucs</b> (roughly 1–3× the song length on a 4-core CPU). High quality uses <b>htdemucs_ft</b>, four
            fine-tuned models — cleaner vocals and bass, but about 4–6× slower. You can pick per track from the library's right-click menu.
          </div>
          <label>CPU threads</label>
          <div className="row">
            <input type="range" min={1} max={cores} value={settings.threads} onChange={(e) => void update({ threads: Number(e.target.value) })} style={{ width: 220 }} />
            <span className="mono">
              {settings.threads} / {cores}
            </span>
          </div>
          <div className="hint">Leave at least one core free so playback stays smooth while tracks are processing.</div>
          <label>Use GPU when available</label>
          <label className="row">
            <input type="checkbox" checked={settings.use_gpu} onChange={(e) => void update({ use_gpu: e.target.checked })} />
            {health?.cuda ? <span className="chip ok">{health.device} detected</span> : <span className="faint">No compatible NVIDIA GPU detected — CPU will be used</span>}
          </label>
          <label>Stem file format</label>
          <div className="seg">
            <button className={settings.stem_format === 'flac' ? 'on' : ''} onClick={() => void update({ stem_format: 'flac' })}>
              FLAC (half the disk space)
            </button>
            <button className={settings.stem_format === 'wav' ? 'on' : ''} onClick={() => void update({ stem_format: 'wav' })}>
              WAV
            </button>
          </div>
          <label>Auto-separate on import</label>
          <label className="row">
            <input type="checkbox" checked={settings.auto_separate} onChange={(e) => void update({ auto_separate: e.target.checked })} />
            <span className="faint">Queue every newly imported track for separation</span>
          </label>

          <div className="section-title">Appearance & performance</div>
          <label>Reduce transparency</label>
          <label className="row">
            <input type="checkbox" checked={settings.reduce_transparency} onChange={(e) => void update({ reduce_transparency: e.target.checked })} />
            <span className="faint">Turns off the glass blur effect — helps on older integrated graphics</span>
          </label>

          <div className="section-title">Engine</div>
          <label>Time-stretch engine</label>
          <div>{health?.stretch_engine}</div>
          <label>Separation</label>
          <div>{health?.torch ? (health.cuda ? `PyTorch on GPU (${health.device})` : 'PyTorch on CPU') : 'PyTorch / Demucs not installed — see README'}</div>
        </div>
      </div>
    </div>
  );
}
