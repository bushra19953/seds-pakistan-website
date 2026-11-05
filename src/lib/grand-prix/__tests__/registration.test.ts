import {
  checkWindowAndDuplicates,
  emptyIndex,
  getWindowState,
  publicRegistrationStatus,
  validateRegistration,
  INITIAL_CLOSE_MS,
  LATE_CLOSE_MS,
  LATE_OPEN_MS,
  type EnrolmentInput,
} from '../registration';

const IN_INITIAL_WINDOW = INITIAL_CLOSE_MS - 60_000;
const BETWEEN_WINDOWS = LATE_OPEN_MS - 60_000;
const IN_LATE_WINDOW = LATE_CLOSE_MS - 60_000;
const AFTER_LATE_CLOSE = LATE_CLOSE_MS + 1;

function validInput(overrides: Partial<EnrolmentInput> = {}): EnrolmentInput {
  return {
    fullName: 'Ayesha Khan',
    studentId: 'STU-001',
    email: 'ayesha@example.edu',
    discipline: 'Avionics',
    whatsapp: '+92 300 1234567',
    nation: 'PK',
    passType: 'student',
    institutionName: 'Institute of Space Technology',
    institutionId: 'IST-2026',
    city: 'Islamabad',
    ...overrides,
  };
}

function mustValidate(input: EnrolmentInput) {
  const result = validateRegistration(input);
  if (!result.ok) throw new Error(`expected valid, got: ${result.errors.join('; ')}`);
  return result.value;
}

describe('validateRegistration', () => {
  it('accepts a complete individual enrolment and normalizes fields', () => {
    const value = mustValidate(validInput({ nation: 'pk', passType: 'STUDENT' }));
    expect(value.nation).toBe('PK');
    expect(value.passType).toBe('student');
    expect(value.leadEmail).toBe('ayesha@example.edu');
    expect(value.studentIdKey).toBe('ist-2026::stu-001');
  });

  it('accepts the industry observer pass', () => {
    const value = mustValidate(validInput({ passType: 'industry' }));
    expect(value.passType).toBe('industry');
  });

  it('rejects an unknown nation and an unknown pass type', () => {
    const result = validateRegistration(validInput({ nation: 'IN', passType: 'vip' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/Pakistan \(PK\) or Sri Lanka \(LK\)/);
      expect(result.errors.join(' ')).toMatch(/Pass type must be/);
    }
  });

  it('requires the WhatsApp number and every institutional field', () => {
    const result = validateRegistration(validInput({ institutionId: '', whatsapp: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/Institution verification ID is required/);
      expect(result.errors.join(' ')).toMatch(/WhatsApp number is required/);
    }
  });

  it('rejects a bad email and a missing full name', () => {
    const result = validateRegistration(validInput({ email: 'not-an-email', fullName: 'Al' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/valid email is required/);
      expect(result.errors.join(' ')).toMatch(/Full name is required/);
    }
  });
});

describe('getWindowState', () => {
  it('is open in the initial window until Nov 15 2026 23:59 PKT', () => {
    const state = getWindowState(IN_INITIAL_WINDOW);
    expect(state.state).toBe('open');
    expect(state.open).toBe(true);
    expect(state.closesAt).toBe('2026-11-15T23:59:00+05:00');
  });

  it('is closed between the windows and names the late opening', () => {
    const state = getWindowState(BETWEEN_WINDOWS);
    expect(state.state).toBe('closed');
    expect(state.open).toBe(false);
    expect(state.opensAt).toBe('2026-11-21T09:00:00+05:00');
  });

  it('is late admission open inside Nov 21 09:00 to Nov 28 23:59 PKT', () => {
    const state = getWindowState(IN_LATE_WINDOW);
    expect(state.state).toBe('late');
    expect(state.open).toBe(true);
    expect(state.closesAt).toBe('2026-11-28T23:59:00+05:00');
  });

  it('is closed after the late window ends', () => {
    const state = getWindowState(AFTER_LATE_CLOSE);
    expect(state.state).toBe('closed');
    expect(state.open).toBe(false);
    expect(state.opensAt).toBeNull();
    expect(state.closesAt).toBeNull();
  });
});

describe('checkWindowAndDuplicates', () => {
  it('admits the first enrolment and advances the index', () => {
    const reg = mustValidate(validInput());
    const result = checkWindowAndDuplicates(emptyIndex(), reg, IN_INITIAL_WINDOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextIndex.total).toBe(1);
      expect(result.nextIndex.emails).toEqual(['ayesha@example.edu']);
      expect(result.nextIndex.studentIdKeys).toHaveLength(1);
    }
  });

  it('admits an enrolment during the late admission window', () => {
    const reg = mustValidate(validInput());
    const result = checkWindowAndDuplicates(emptyIndex(), reg, IN_LATE_WINDOW);
    expect(result.ok).toBe(true);
  });

  it('refuses enrolment between the windows with 410', () => {
    const reg = mustValidate(validInput());
    const result = checkWindowAndDuplicates(emptyIndex(), reg, BETWEEN_WINDOWS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(410);
      expect(result.error).toMatch(/Late admission opens Nov 21, 2026/);
    }
  });

  it('refuses enrolment after the late window with 410', () => {
    const reg = mustValidate(validInput());
    const result = checkWindowAndDuplicates(emptyIndex(), reg, AFTER_LATE_CLOSE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(410);
      expect(result.error).toMatch(/late admission window ended Nov 28, 2026/);
    }
  });

  it('blocks a duplicate email and a duplicate student ID', () => {
    const first = mustValidate(validInput());
    const admitted = checkWindowAndDuplicates(emptyIndex(), first, IN_INITIAL_WINDOW);
    if (!admitted.ok) throw new Error('setup failed');
    const index = admitted.nextIndex;

    const dupEmail = checkWindowAndDuplicates(
      index,
      mustValidate(validInput({ studentId: 'STU-999' })),
      IN_INITIAL_WINDOW,
    );
    expect(dupEmail.ok).toBe(false);
    if (!dupEmail.ok) expect(dupEmail.status).toBe(409);

    const dupId = checkWindowAndDuplicates(
      index,
      mustValidate(validInput({ email: 'other@example.edu' })),
      IN_INITIAL_WINDOW,
    );
    expect(dupId.ok).toBe(false);
    if (!dupId.ok) expect(dupId.error).toMatch(/already enrolled/);
  });
});

describe('publicRegistrationStatus', () => {
  it('reports open with counts and no identity data', () => {
    const index = emptyIndex();
    index.total = 3;
    const status = publicRegistrationStatus(index, IN_INITIAL_WINDOW);
    expect(status.open).toBe(true);
    expect(status.state).toBe('open');
    expect(status.totalRegistered).toBe(3);
    expect(JSON.stringify(status)).not.toMatch(/@/);
  });

  it('reports late admission open inside the late window', () => {
    const status = publicRegistrationStatus(emptyIndex(), IN_LATE_WINDOW);
    expect(status.open).toBe(true);
    expect(status.state).toBe('late');
  });

  it('reports closed between the windows', () => {
    const status = publicRegistrationStatus(emptyIndex(), BETWEEN_WINDOWS);
    expect(status.open).toBe(false);
    expect(status.state).toBe('closed');
  });
});
