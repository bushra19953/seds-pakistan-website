import { chunkDescription } from '../description-chunks';

// Exact stored Pod 3B Step 1 description (crucible template paragraph).
const FIXTURE =
  '72-Hour Crucible task SEDS-TASK-ROV-SRILANKA-002. Pod: Pod 3B: Mechanical Chassis, Drivetrain & Soil Mechanics (7 Candidates). Squad: Planetary Rover Squad. Candidate: Aurangzaib (Y3 Aero). Deliverable: Motor torque calculation sheet (.xlsx). Source files, inside the Crucible Resource Package linked as this step\'s resource: 03_Track2_Planetary_Rover_Arsenal/nasa-jpl-open-source-rover/parts_list/parts_list.csv. Verification: Python unit test verifying gearmotor torque safety factor ge 1.5 on 20^circ incline; Chapter VP Chapter VP Ahmed Ali Kamran review. Pod handoff: scales down the NASA JPL Open Source Rover to the UKSEDS volume envelope (300 times 300 times 300text{ mm}, mass <= 5.0text{ kg}), creating the master CAD assembly in STEP format. Reviewer: Ahmed Ali Kamran (Chapter Vice President) [Rover Unit Lead Seat: VACANT]. Faculty patron: Prof. Dr. Najam Abbas Naqvi (Chairman NCGSA). Estimated time: 180 minutes. Zero personal spend. Your deliverable must compile, parse, or render without errors. No non-standard external dependencies. Charter: PK-LK:SEDS-CHARTER:2026-10-25/V2.0 (South Asia Grand Prix with SEDS Sri Lanka). Submit your deliverable link from your profile on sedspakistan.live before the deadline: Thursday, October 29, 2026, 11:59 PM PKT.';

describe('chunkDescription — crucible template paragraph', () => {
  const chunks = chunkDescription(FIXTURE);

  it('opens with the Task chunk carrying the task id', () => {
    expect(chunks[0]).toEqual({ label: 'Task', text: 'SEDS-TASK-ROV-SRILANKA-002' });
  });

  it('produces the template labels in order', () => {
    const labels = chunks.map((c) => c.label).filter((l) => l !== null);
    expect(labels).toEqual([
      'Task',
      'Pod',
      'Squad',
      'Candidate',
      'Deliverable',
      'Source files',
      'Verification',
      'Pod handoff',
      'Reviewer',
      'Faculty patron',
      'Estimated time',
      'Charter',
      'Submit',
    ]);
  });

  it('keeps labeled values whole', () => {
    const byLabel = new Map(chunks.filter((c) => c.label).map((c) => [c.label, c.text]));
    expect(byLabel.get('Pod')).toBe(
      'Pod 3B: Mechanical Chassis, Drivetrain & Soil Mechanics (7 Candidates).',
    );
    expect(byLabel.get('Squad')).toBe('Planetary Rover Squad.');
    expect(byLabel.get('Candidate')).toBe('Aurangzaib (Y3 Aero).');
    expect(byLabel.get('Deliverable')).toBe('Motor torque calculation sheet (.xlsx).');
    expect(byLabel.get('Source files')).toBe(
      '03_Track2_Planetary_Rover_Arsenal/nasa-jpl-open-source-rover/parts_list/parts_list.csv.',
    );
    expect(byLabel.get('Estimated time')).toBe('180 minutes.');
    expect(byLabel.get('Charter')).toBe(
      'PK-LK:SEDS-CHARTER:2026-10-25/V2.0 (South Asia Grand Prix with SEDS Sri Lanka).',
    );
    expect(byLabel.get('Submit')).toBe('Thursday, October 29, 2026, 11:59 PM PKT.');
  });

  it('splits the Verification value on "; " into two chunks, label on the first', () => {
    const idx = chunks.findIndex((c) => c.label === 'Verification');
    expect(chunks[idx].text).toBe(
      'Python unit test verifying gearmotor torque safety factor ge 1.5 on 20^circ incline',
    );
    expect(chunks[idx + 1]).toEqual({
      label: null,
      text: 'Chapter VP Chapter VP Ahmed Ali Kamran review.',
    });
  });

  it('does not split the faculty patron name at "Prof. Dr."', () => {
    const patron = chunks.find((c) => c.label === 'Faculty patron');
    expect(patron?.text).toBe('Prof. Dr. Najam Abbas Naqvi (Chairman NCGSA).');
  });

  it('makes each boilerplate sentence its own unlabeled chunk', () => {
    const texts = chunks.map((c) => c.text);
    expect(texts).toContain('Zero personal spend.');
    expect(texts).toContain('Your deliverable must compile, parse, or render without errors.');
    expect(texts).toContain('No non-standard external dependencies.');
    const zero = chunks.find((c) => c.text === 'Zero personal spend.');
    expect(zero?.label).toBeNull();
  });

  it('preserves every key fact somewhere in the chunks', () => {
    const joined = chunks.map((c) => c.text).join(' ');
    for (const fact of [
      'Motor torque calculation sheet (.xlsx)',
      'parts_list.csv',
      'safety factor ge 1.5',
      '180 minutes',
      'PK-LK:SEDS-CHARTER:2026-10-25/V2.0',
      'October 29, 2026, 11:59 PM PKT',
      'Aurangzaib (Y3 Aero)',
      'Ahmed Ali Kamran (Chapter Vice President) [Rover Unit Lead Seat: VACANT]',
      '300text{ mm}, mass <= 5.0text{ kg}',
    ]) {
      expect(joined).toContain(fact);
    }
  });

  it('never returns a chunk longer than one template section', () => {
    // The whole point: no wall-of-text chunk. Every chunk is one labeled
    // section, one clause, or one sentence.
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(220);
    }
    expect(chunks.length).toBeGreaterThanOrEqual(16);
  });
});

describe('chunkDescription — generic prose and edge cases', () => {
  it('splits unlabeled prose into one chunk per sentence', () => {
    const chunks = chunkDescription(
      'Alpha bravo charlie. Delta echo foxtrot. Golf hotel india.',
    );
    expect(chunks).toEqual([
      { label: null, text: 'Alpha bravo charlie.' },
      { label: null, text: 'Delta echo foxtrot.' },
      { label: null, text: 'Golf hotel india.' },
    ]);
  });

  it('does not split decimals, file paths, or domains', () => {
    const chunks = chunkDescription(
      'The factor is 1.5 exactly. See parts_list.csv on sedspakistan.live for the data.',
    );
    expect(chunks).toEqual([
      { label: null, text: 'The factor is 1.5 exactly.' },
      { label: null, text: 'See parts_list.csv on sedspakistan.live for the data.' },
    ]);
  });

  it('keeps a single sentence as a single chunk', () => {
    expect(chunkDescription('Just one instruction with no labels.')).toEqual([
      { label: null, text: 'Just one instruction with no labels.' },
    ]);
  });

  it('normalizes whitespace and newlines', () => {
    const chunks = chunkDescription('First sentence.\n\n   Second   sentence.');
    expect(chunks).toEqual([
      { label: null, text: 'First sentence.' },
      { label: null, text: 'Second sentence.' },
    ]);
  });

  it('returns [] for empty or whitespace-only input', () => {
    expect(chunkDescription('')).toEqual([]);
    expect(chunkDescription('   \n  ')).toEqual([]);
  });
});
