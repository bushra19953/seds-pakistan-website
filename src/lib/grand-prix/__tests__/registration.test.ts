import {
  checkCapsAndDuplicates,
  emptyIndex,
  publicBracketStatus,
  validateRegistration,
  REGISTRATION_CLOSE_MS,
  type RegistrationInput,
} from '../registration';

const BEFORE_CLOSE = REGISTRATION_CLOSE_MS - 60_000;

function validInput(overrides: Partial<RegistrationInput> = {}): RegistrationInput {
  return {
    squadName: 'Falcon Dynamics',
    nation: 'PK',
    track: 'rocketry',
    institutionName: 'Institute of Space Technology',
    institutionId: 'IST-2026',
    city: 'Islamabad',
    members: [1, 2, 3, 4, 5].map((n) => ({
      fullName: `Member ${n} Test`,
      studentId: `STU-00${n}`,
      email: `member${n}@example.edu`,
      discipline: n % 2 === 0 ? 'Avionics' : 'Structures',
      whatsapp: n === 1 ? '+92 300 1234567' : undefined,
    })),
    ...overrides,
  };
}

function mustValidate(input: RegistrationInput) {
  const result = validateRegistration(input);
  if (!result.ok) throw new Error(`expected valid, got: ${result.errors.join('; ')}`);
  return result.value;
}

describe('validateRegistration', () => {
  it('accepts a complete 5 seat squad and normalizes fields', () => {
    const value = mustValidate(validInput({ nation: 'pk', track: 'ROCKETRY' }));
    expect(value.nation).toBe('PK');
    expect(value.track).toBe('rocketry');
    expect(value.members).toHaveLength(5);
    expect(value.members[0].isLead).toBe(true);
    expect(value.members[0].whatsapp).toBe('+92 300 1234567');
    expect(value.members[1].whatsapp).toBeNull();
    expect(value.leadEmail).toBe('member1@example.edu');
    expect(value.studentIdKeys[0]).toBe('ist-2026::stu-001');
  });

  it('rejects a squad with fewer than 5 members', () => {
    const input = validInput();
    input.members = input.members.slice(0, 4);
    const result = validateRegistration(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/exactly 5 members/);
  });

  it('rejects an unknown nation and an unknown track', () => {
    const result = validateRegistration(validInput({ nation: 'IN', track: 'drones' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/Pakistan \(PK\) or Sri Lanka \(LK\)/);
      expect(result.errors.join(' ')).toMatch(/Track must be one of/);
    }
  });

  it('rejects duplicate emails and duplicate student IDs inside the squad', () => {
    const input = validInput();
    input.members[2].email = input.members[0].email;
    input.members[3].studentId = input.members[1].studentId;
    const result = validateRegistration(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/email is already used/);
      expect(result.errors.join(' ')).toMatch(/student ID is already used/);
    }
  });

  it('requires the lead WhatsApp number and every institutional ID field', () => {
    const input = validInput({ institutionId: '' });
    input.members[0].whatsapp = '';
    const result = validateRegistration(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/Institution verification ID is required/);
      expect(result.errors.join(' ')).toMatch(/WhatsApp number is required/);
    }
  });
});

describe('checkCapsAndDuplicates', () => {
  it('admits the first squad and advances the index', () => {
    const reg = mustValidate(validInput());
    const result = checkCapsAndDuplicates(emptyIndex(), reg, BEFORE_CLOSE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextIndex.total).toBe(1);
      expect(result.nextIndex.byNation.PK).toBe(1);
      expect(result.nextIndex.byTrack.rocketry).toBe(1);
      expect(result.nextIndex.studentIdKeys).toHaveLength(5);
    }
  });

  it('blocks a 16th squad from one nation but still admits the other nation', () => {
    const index = emptyIndex();
    index.total = 15;
    index.byNation.PK = 15;
    const pkReg = mustValidate(validInput());
    const blocked = checkCapsAndDuplicates(index, pkReg, BEFORE_CLOSE);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.status).toBe(409);

    const lkReg = mustValidate(validInput({ nation: 'LK', squadName: 'Lanka Orbit' }));
    lkReg.members = lkReg.members.map((m, i) => ({ ...m, email: `lk${i}@example.edu` }));
    lkReg.leadEmail = 'lk0@example.edu';
    lkReg.studentIdKeys = lkReg.studentIdKeys.map((k) => k.replace('stu', 'lkstu'));
    const admitted = checkCapsAndDuplicates(index, lkReg, BEFORE_CLOSE);
    expect(admitted.ok).toBe(true);
  });

  it('blocks an 11th squad in one track', () => {
    const index = emptyIndex();
    index.byTrack.flatsat = 10;
    const reg = mustValidate(validInput({ track: 'flatsat' }));
    const result = checkCapsAndDuplicates(index, reg, BEFORE_CLOSE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/track is full/);
  });

  it('closes for everyone after the Nov 15 2026 23:59 PKT deadline', () => {
    const reg = mustValidate(validInput());
    const result = checkCapsAndDuplicates(emptyIndex(), reg, REGISTRATION_CLOSE_MS + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(410);
  });

  it('blocks duplicate lead email, squad name, and cross squad student IDs', () => {
    const first = mustValidate(validInput());
    const admitted = checkCapsAndDuplicates(emptyIndex(), first, BEFORE_CLOSE);
    if (!admitted.ok) throw new Error('setup failed');
    const index = admitted.nextIndex;

    const dupAll = mustValidate(validInput());
    const dupResult = checkCapsAndDuplicates(index, dupAll, BEFORE_CLOSE);
    expect(dupResult.ok).toBe(false);

    const other = validInput({ squadName: 'Different Name' });
    other.members = other.members.map((m, i) => ({
      ...m,
      email: `other${i}@example.edu`,
      studentId: i === 4 ? 'STU-001' : `NEW-00${i}`,
    }));
    const clashResult = checkCapsAndDuplicates(index, mustValidate(other), BEFORE_CLOSE);
    expect(clashResult.ok).toBe(false);
    if (!clashResult.ok) expect(clashResult.error).toMatch(/already registered with another squad/);
  });
});

describe('publicBracketStatus', () => {
  it('reports open with counts and no identity data', () => {
    const index = emptyIndex();
    index.total = 3;
    index.byNation.PK = 2;
    index.byNation.LK = 1;
    const status = publicBracketStatus(index, BEFORE_CLOSE);
    expect(status.open).toBe(true);
    expect(status.totalRegistered).toBe(3);
    expect(JSON.stringify(status)).not.toMatch(/@/);
  });

  it('reports closed when the bracket is full', () => {
    const index = emptyIndex();
    index.total = 30;
    expect(publicBracketStatus(index, BEFORE_CLOSE).open).toBe(false);
  });
});
