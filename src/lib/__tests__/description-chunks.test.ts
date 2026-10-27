import { chunkDescription, normalizeDescriptionText } from '../description-chunks';

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
      'Python unit test verifying gearmotor torque safety factor ge 1.5 on 20° incline',
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
      '300 × 300 × 300 mm, mass <= 5.0 kg',
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

describe('normalizeDescriptionText — LaTeX artifact repair (real corpus strings)', () => {
  it('rewrites _{text{...}} subscripts to _word form', () => {
    expect(normalizeDescriptionText('proving V_{text{flutter}} / V_{text{max}} ge 1.5')).toBe(
      'proving V_flutter / V_max ge 1.5',
    );
    expect(normalizeDescriptionText('peak pressure (P_{text{max}}) sizes the casing')).toBe(
      'peak pressure (P_max) sizes the casing',
    );
    expect(
      normalizeDescriptionText('flow balance Q_{text{in}} = Q_{text{out}} at steady state'),
    ).toBe('flow balance Q_in = Q_out at steady state');
    expect(normalizeDescriptionText('static friction mu_{text{static}} and q_{text{max}}')).toBe(
      'static friction mu_static and q_max',
    );
  });

  it('drops braces on any remaining _{X} / ^{X}', () => {
    expect(normalizeDescriptionText('sample x_{i} peaks at y^{2} today')).toBe(
      'sample x_i peaks at y^2 today',
    );
  });

  it('renders degrees and degrees Celsius', () => {
    expect(normalizeDescriptionText('bond line < 120^circtext{C} during cure')).toBe(
      'bond line < 120°C during cure',
    );
    expect(normalizeDescriptionText('glass transition T_g ge 120^circtext{C}')).toBe(
      'glass transition T_g ge 120°C',
    );
    expect(normalizeDescriptionText('cold soak down to -20^circtext{C} overnight')).toBe(
      'cold soak down to -20°C overnight',
    );
    expect(normalizeDescriptionText('climbs a 20^circ incline fully loaded')).toBe(
      'climbs a 20° incline fully loaded',
    );
  });

  it('unglues units from numbers and unwraps text{...}', () => {
    expect(normalizeDescriptionText('mass <= 5.0text{ kg} all-in')).toBe('mass <= 5.0 kg all-in');
    expect(normalizeDescriptionText('verify total impulse <= 130text{ Ns} across all curves')).toBe(
      'verify total impulse <= 130 Ns across all curves',
    );
    expect(normalizeDescriptionText('impulse 250text{ Ns} measured on the stand')).toBe(
      'impulse 250 Ns measured on the stand',
    );
    expect(normalizeDescriptionText('small 5-10text{ cm} parts in a 762text{ m} drop zone')).toBe(
      'small 5-10 cm parts in a 762 m drop zone',
    );
    expect(normalizeDescriptionText('ripple < 30text{ mV} at 3.3text{ V} and 9.5text{ kHz}')).toBe(
      'ripple < 30 mV at 3.3 V and 9.5 kHz',
    );
  });

  it('keeps a standalone text{FOS} as the plain word, plain "ge" untouched', () => {
    expect(normalizeDescriptionText('proving casing retention text{FOS} ge 2.0')).toBe(
      'proving casing retention FOS ge 2.0',
    );
  });

  it('converts numeric "times" chains to ×', () => {
    expect(normalizeDescriptionText('envelope (300 times 300 times 300text{ mm}) max')).toBe(
      'envelope (300 × 300 × 300 mm) max',
    );
    expect(normalizeDescriptionText('footprint (100 times 100 times 340.5text{ mm}) nominal')).toBe(
      'footprint (100 × 100 × 340.5 mm) nominal',
    );
    // The word "times" in prose is not multiplication.
    expect(normalizeDescriptionText('run the check three times before submitting')).toBe(
      'run the check three times before submitting',
    );
  });

  it('renders the mangled \\cdot in N}cdottext{m} as ·', () => {
    expect(normalizeDescriptionText('snatch torque > 0.8text{ N}cdottext{m} peak')).toBe(
      'snatch torque > 0.8 N·m peak',
    );
  });

  it('renders \\pm and its backslash-less corpus form as ±', () => {
    expect(normalizeDescriptionText('range (762text{ m} pm 20text{ ft}) from the pad')).toBe(
      'range (762 m ± 20 ft) from the pad',
    );
    expect(normalizeDescriptionText('verify pm 25^circ tolerance on the rail')).toBe(
      'verify ± 25° tolerance on the rail',
    );
    expect(normalizeDescriptionText('tolerance \\pm 0.5text{ mm} on the bore')).toBe(
      'tolerance ± 0.5 mm on the bore',
    );
    // A clock time is not a plus-minus.
    expect(normalizeDescriptionText('Submit before 11:59 PM PKT sharp')).toBe(
      'Submit before 11:59 PM PKT sharp',
    );
  });

  it('maps defensive LaTeX commands and strips $ delimiters', () => {
    expect(normalizeDescriptionText('ratio $A_{tot}$ holds with \\times 2 headroom')).toBe(
      'ratio A_tot holds with × 2 headroom',
    );
    expect(normalizeDescriptionText('margin \\ge 10\\% and error \\le 2\\% overall')).toBe(
      'margin >= 10% and error <= 2% overall',
    );
    expect(normalizeDescriptionText('the file\\_name field and a \\degree mark')).toBe(
      'the file_name field and a ° mark',
    );
  });

  it('never touches the plain word "text" or ordinary prose', () => {
    expect(normalizeDescriptionText('Submit the text file with your report.')).toBe(
      'Submit the text file with your report.',
    );
    expect(normalizeDescriptionText('The safety factor ge 1.5 stays a plain word.')).toBe(
      'The safety factor ge 1.5 stays a plain word.',
    );
  });

  it('applies inside chunkDescription output end to end', () => {
    const chunks = chunkDescription(
      'Verification: Python check on a 20^circ incline; casing retention text{FOS} ge 2.0.',
    );
    expect(chunks).toEqual([
      { label: 'Verification', text: 'Python check on a 20° incline' },
      { label: null, text: 'casing retention FOS ge 2.0.' },
    ]);
    const wordChunks = chunkDescription('Submit the text file with your report.');
    expect(wordChunks).toEqual([{ label: null, text: 'Submit the text file with your report.' }]);
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
