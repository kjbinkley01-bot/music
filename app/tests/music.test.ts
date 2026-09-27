import { describe, expect, it } from 'vitest';
import { bpmMatch, camelotName, keyCompatibility, semitonesToMatch, shiftKey } from '../src/music';
import { autoValueAt, filterFreqs } from '../src/remix/model';

describe('camelot', () => {
  it('maps keys onto the wheel', () => {
    expect(camelotName({ pc: 9, mode: 'minor' })).toBe('8A');
    expect(camelotName({ pc: 0, mode: 'major' })).toBe('8B');
    expect(camelotName({ pc: 11, mode: 'major' })).toBe('1B');
    expect(camelotName({ pc: 8, mode: 'minor' })).toBe('1A');
  });
  it('rates compatibility', () => {
    const am = { pc: 9, mode: 'minor' as const };
    expect(keyCompatibility(am, am)).toBe('perfect');
    expect(keyCompatibility(am, { pc: 0, mode: 'major' })).toBe('good'); // relative major
    expect(keyCompatibility(am, { pc: 4, mode: 'minor' })).toBe('good'); // 9A
    expect(keyCompatibility({ pc: 8, mode: 'minor' }, { pc: 1, mode: 'minor' })).toBe('good'); // 1A-12A wrap
    expect(keyCompatibility(am, { pc: 3, mode: 'minor' })).toBe('clash');
    expect(keyCompatibility(null, am)).toBe('unknown');
  });
  it('finds the smallest shift onto a key', () => {
    const c = { pc: 0, mode: 'major' as const };
    expect(semitonesToMatch(c, { pc: 9, mode: 'minor' })).toBe(0);
    expect(semitonesToMatch(c, { pc: 10, mode: 'major' })).toBe(-2);
    const shifted = shiftKey(c, semitonesToMatch(c, { pc: 7, mode: 'major' }));
    expect(keyCompatibility(shifted, { pc: 7, mode: 'major' })).toBe('perfect');
  });
});

describe('tempo', () => {
  it('matches half and double time', () => {
    expect(bpmMatch(128, 126)).toBeCloseTo(126 / 128);
    expect(bpmMatch(87, 174)).toBeCloseTo(1);
    expect(bpmMatch(174, 87)).toBeCloseTo(1);
    expect(bpmMatch(128, 100)).toBeNull();
  });
});

describe('automation & filter', () => {
  it('interpolates points and holds the ends', () => {
    const pts = [{ beat: 4, value: -1 }, { beat: 8, value: 0 }];
    expect(autoValueAt(pts, 0, 0.5)).toBe(-1);
    expect(autoValueAt(pts, 6, 0.5)).toBeCloseTo(-0.5);
    expect(autoValueAt(pts, 20, 0.5)).toBe(0);
    expect(autoValueAt([], 3, 0.25)).toBe(0.25);
  });
  it('maps the filter knob', () => {
    expect(filterFreqs(0)[0]).toBe(22000);
    expect(filterFreqs(0)[1]).toBe(10);
    expect(filterFreqs(-1)[0]).toBeCloseTo(150);
    expect(filterFreqs(1)[1]).toBeCloseTo(6000);
  });
});
