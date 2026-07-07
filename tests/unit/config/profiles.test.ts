import { describe, it, expect } from 'vitest';
import { getEnabledProfiles, PROFILE_DEFINITIONS } from '../../../src/config/profiles.js';

describe('getEnabledProfiles', () => {
  it('should return only core for core profile', () => {
    const profiles = getEnabledProfiles('core');
    expect(profiles).toEqual(['core']);
  });

  it('should return core and pro for pro profile', () => {
    const profiles = getEnabledProfiles('pro');
    expect(profiles).toEqual(['core', 'pro']);
  });

  it('should return all profiles for experimental', () => {
    const profiles = getEnabledProfiles('experimental');
    expect(profiles).toHaveLength(5);
  });

  it('should fallback to core for unknown profile', () => {
    const profiles = getEnabledProfiles('unknown' as never);
    expect(profiles).toEqual(['core']);
  });
});

describe('PROFILE_DEFINITIONS', () => {
  it('should have core as default', () => {
    expect(PROFILE_DEFINITIONS.core.isDefault).toBe(true);
  });

  it('should define all five profiles', () => {
    expect(Object.keys(PROFILE_DEFINITIONS)).toHaveLength(5);
  });

  it('should have non-empty descriptions', () => {
    for (const def of Object.values(PROFILE_DEFINITIONS)) {
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it('should have accurate approxToolCount for core', () => {
    expect(PROFILE_DEFINITIONS.core.approxToolCount).toBe('52');
  });

  it('should have accurate approxToolCount for pro', () => {
    expect(PROFILE_DEFINITIONS.pro.approxToolCount).toBe('67');
  });

  it('should have accurate approxToolCount for full', () => {
    expect(PROFILE_DEFINITIONS.full.approxToolCount).toBe('77');
  });
});
