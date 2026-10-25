/**
 * Suite H settings (spec L4): the platform switches must survive the
 * settings editor's save whitelist. The editor writes an explicit
 * updateDoc field list, so a toggle missing from that list would
 * silently never persist; this suite pins both fields inside the
 * handleSave payload and the defaults in the types module.
 */

import * as fs from 'fs';
import * as path from 'path';

const editor = fs.readFileSync(
  path.join(process.cwd(), 'src/components/admin/site-settings-management.tsx'),
  'utf8',
);
const payloadLib = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/site-settings-payload.ts'),
  'utf8',
);
const types = fs.readFileSync(
  path.join(process.cwd(), 'src/types/site-settings.ts'),
  'utf8',
);

describe('site settings platform switches', () => {
  it('both switches are in the save whitelist (buildSiteWideSave, used by handleSave)', () => {
    // The whitelist moved verbatim from the component into
    // src/lib/site-settings-payload.ts (buildSiteWideSave) when the
    // payload builders were extracted for the Supabase mirror.
    const saveStart = payloadLib.indexOf('export function buildSiteWideSave');
    const saveBlock = payloadLib.slice(saveStart);
    expect(saveBlock).toContain('siteEnabled:');
    expect(saveBlock).toContain('maintenanceMode:');
    expect(editor).toContain('buildSiteWideSave(settings, studentsCount, user.uid)');
  });

  it('both switches render as toggles in the editor', () => {
    expect(editor).toContain("handleInputChange('siteEnabled'");
    expect(editor).toContain("handleInputChange('maintenanceMode'");
  });

  it('defaults are the live state (siteEnabled true, maintenanceMode false)', () => {
    expect(types).toContain('siteEnabled: true');
    expect(types).toContain('maintenanceMode: false');
    expect(types).toContain('siteEnabled?: boolean');
    expect(types).toContain('maintenanceMode?: boolean');
  });
});
