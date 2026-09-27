import { useMemo } from 'react';
import { ACTIONS } from '../midi/actions';
import { exportMappings, importMappings, useMidi } from '../midi/midi';
import { reportError, useApp } from '../store/app';

export function MidiView() {
  const { supported, devices, mappings, learning, last, learn, setMappings } = useMidi();
  const groups = useMemo(() => {
    const m = new Map<string, typeof ACTIONS>();
    for (const a of ACTIONS) m.set(a.group, [...(m.get(a.group) ?? []), a]);
    return [...m.entries()];
  }, []);

  const mappingFor = (action: string) => mappings.filter((m) => m.action === action);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 12, height: '100%' }}>
      <div className="glass panel">
        <div className="panel-head">
          <span className="panel-title">MIDI learn</span>
          <span className="faint">Click Learn, then move a knob or press a button on your controller.</span>
          <div className="spacer" />
          {learning && (
            <button className="btn sm" onClick={() => learn(null)}>
              Cancel learn
            </button>
          )}
        </div>
        <div className="panel-body" style={{ padding: '4px 14px 14px' }}>
          {groups.map(([group, actions]) => (
            <div key={group} style={{ marginTop: 14 }}>
              <div className="section-title" style={{ marginBottom: 6 }}>
                {group}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 6 }}>
                {actions.map((a) => {
                  const maps = mappingFor(a.id);
                  const isLearning = learning === a.id;
                  return (
                    <div key={a.id} className="row" style={{ padding: '5px 8px', borderRadius: 8, background: isLearning ? 'rgba(90,209,255,0.12)' : 'rgba(255,255,255,0.025)', border: `1px solid ${isLearning ? 'var(--accent)' : 'var(--line)'}` }}>
                      <span className="grow ellipsis">{a.label}</span>
                      {maps.map((m) => (
                        <span key={m.id} className="chip ok mono" title={m.device || 'any device'}>
                          {m.type === 'cc' ? 'CC' : 'Note'} {m.number}
                          <span style={{ cursor: 'pointer', marginLeft: 3 }} onClick={() => setMappings(mappings.filter((x) => x.id !== m.id))}>
                            ×
                          </span>
                        </span>
                      ))}
                      <button className={`btn sm ${isLearning ? 'on' : ''}`} disabled={!supported} onClick={() => learn(isLearning ? null : a.id)}>
                        {isLearning ? 'Waiting…' : 'Learn'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="col">
        <div className="glass" style={{ padding: 14 }}>
          <div className="panel-title" style={{ marginBottom: 8 }}>
            Devices
          </div>
          {!supported ? (
            <div className="muted">Web MIDI isn’t available.</div>
          ) : devices.length === 0 ? (
            <div className="muted">No MIDI controller detected. Plug one in — it will appear here automatically.</div>
          ) : (
            devices.map((d) => (
              <div key={d} className="row">
                <span className="stem-dot stem-other" /> {d}
              </div>
            ))
          )}
          <div className="faint mono" style={{ marginTop: 10, fontSize: 11, minHeight: 16 }}>
            {last || 'Last message: —'}
          </div>
        </div>
        <div className="glass col" style={{ padding: 14 }}>
          <div className="panel-title">Mappings</div>
          <div className="muted">{mappings.length} controls mapped. Mappings save automatically.</div>
          <div className="row">
            <button
              className="btn sm"
              onClick={async () => {
                const ok = await window.stemdeck?.saveJson('stemdeck-midi-mapping.json', exportMappings());
                if (ok) useApp.getState().toast('Mapping saved', 'success');
              }}
            >
              Save to file…
            </button>
            <button
              className="btn sm"
              onClick={async () => {
                const json = await window.stemdeck?.openJson();
                if (!json) return;
                try {
                  const n = importMappings(json);
                  useApp.getState().toast(`Loaded ${n} mappings`, 'success');
                } catch (e) {
                  reportError(e, 'Could not load mapping');
                }
              }}
            >
              Load from file…
            </button>
            <button className="btn sm ghost danger" disabled={!mappings.length} onClick={() => confirm('Clear all MIDI mappings?') && setMappings([])}>
              Clear
            </button>
          </div>
        </div>
        <div className="glass" style={{ padding: 14, fontSize: 12 }}>
          <div className="panel-title" style={{ marginBottom: 6 }}>
            Tips
          </div>
          <ul className="muted" style={{ paddingLeft: 18, margin: 0, lineHeight: 1.6 }}>
            <li>Knobs and faders map to “continuous” controls; buttons and pads to “button” actions.</li>
            <li>Jog wheels usually send relative values — map them to “Jog wheel”.</li>
            <li>Mapping the same control again replaces the old mapping.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
