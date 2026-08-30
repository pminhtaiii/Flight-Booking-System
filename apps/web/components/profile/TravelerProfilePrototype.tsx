'use client';

import { FormEvent, useMemo, useState } from 'react';
import styles from '../../app/prototype/profile/profile-prototype.module.css';

type ProfileSection = 'identity' | 'contact' | 'travelDocument' | 'preferences';
type SaveState = 'idle' | 'saved' | 'conflict';
type SelectOption = { value: string; label: string };

type ProfileDraft = {
  identity: {
    givenName: string;
    middleName: string;
    familyName: string;
    dateOfBirth: string;
    gender: string;
    title: string;
  };
  contact: {
    email: string;
    phoneCountryCode: string;
    phoneNumber: string;
  };
  travelDocument: {
    documentType: string;
    passportNumber: string;
    passportExpiry: string;
    issuingCountry: string;
    nationality: string;
  };
  preferences: {
    seatPreference: string;
    classPreference: string;
  };
};

const initialDraft: ProfileDraft = {
  identity: {
    givenName: 'Maya',
    middleName: 'Linh',
    familyName: 'Chen',
    dateOfBirth: '1992-04-16',
    gender: 'female',
    title: 'ms',
  },
  contact: {
    email: 'maya.chen@example.com',
    phoneCountryCode: '+84',
    phoneNumber: '',
  },
  travelDocument: {
    documentType: 'passport',
    passportNumber: 'P1234567',
    passportExpiry: '',
    issuingCountry: 'VN',
    nationality: 'VN',
  },
  preferences: {
    seatPreference: 'window',
    classPreference: 'economy',
  },
};

const sectionLabels: Record<ProfileSection, string> = {
  identity: 'Identity',
  contact: 'Contact details',
  travelDocument: 'Travel document',
  preferences: 'Travel preferences',
};

const sectionDescriptions: Record<ProfileSection, string> = {
  identity: 'Use your name exactly as it appears on your travel document.',
  contact: 'We only use these details for booking updates and support.',
  travelDocument: 'Stored securely and only used when a booking requires it.',
  preferences: 'Optional defaults that make future searches faster.',
};

const titleOptions: SelectOption[] = [
  { value: '', label: 'Select a title' },
  { value: 'mr', label: 'Mr' },
  { value: 'ms', label: 'Ms' },
  { value: 'mrs', label: 'Mrs' },
  { value: 'mx', label: 'Mx' },
];

const genderOptions: SelectOption[] = [
  { value: '', label: 'Select a gender' },
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'non-binary', label: 'Non-binary' },
  { value: 'prefer-not-to-say', label: 'Prefer not to say' },
];

const documentOptions: SelectOption[] = [
  { value: '', label: 'Select a document' },
  { value: 'passport', label: 'Passport' },
  { value: 'national-id', label: 'National ID' },
];

const countryOptions: SelectOption[] = [
  { value: '', label: 'Select a country' },
  { value: 'VN', label: 'Vietnam' },
  { value: 'SG', label: 'Singapore' },
  { value: 'JP', label: 'Japan' },
  { value: 'US', label: 'United States' },
];

const phoneCountryOptions: SelectOption[] = [
  { value: '+84', label: 'VN +84' },
  { value: '+65', label: 'SG +65' },
  { value: '+81', label: 'JP +81' },
  { value: '+1', label: 'US +1' },
];

const seatOptions: SelectOption[] = [
  { value: '', label: 'No preference' },
  { value: 'window', label: 'Window' },
  { value: 'aisle', label: 'Aisle' },
];

const classOptions: SelectOption[] = [
  { value: '', label: 'No preference' },
  { value: 'economy', label: 'Economy' },
  { value: 'premium-economy', label: 'Premium economy' },
  { value: 'business', label: 'Business' },
];

function getSectionStatus(values: Record<string, string>): 'complete' | 'attention' {
  return Object.values(values).every((value: string) => value.trim().length > 0)
    ? 'complete'
    : 'attention';
}

function getSectionStatusLabel(status: 'complete' | 'attention'): string {
  return status === 'complete' ? 'Complete' : 'Needs attention';
}

function getMaskedPassport(passportNumber: string): string {
  if (!passportNumber) {
    return 'Not added';
  }

  return `•••• ${passportNumber.slice(-4)}`;
}

export function TravelerProfilePrototype(): JSX.Element {
  const [draft, setDraft] = useState<ProfileDraft>(initialDraft);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [showPassport, setShowPassport] = useState<boolean>(false);

  const sectionStatuses = useMemo<Record<ProfileSection, 'complete' | 'attention'>>(
    () => ({
      identity: getSectionStatus(draft.identity),
      contact: getSectionStatus(draft.contact),
      travelDocument: getSectionStatus(draft.travelDocument),
      preferences: getSectionStatus(draft.preferences),
    }),
    [draft],
  );

  const completion = useMemo<number>(() => {
    const values = [
      ...Object.values(draft.identity),
      ...Object.values(draft.contact),
      ...Object.values(draft.travelDocument),
      ...Object.values(draft.preferences),
    ];
    const filled = values.filter((value: string) => value.trim().length > 0).length;
    return Math.round((filled / values.length) * 100);
  }, [draft]);

  function updateField(section: ProfileSection, field: string, value: string): void {
    setDraft((current: ProfileDraft) => ({
      ...current,
      [section]: {
        ...current[section],
        [field]: value,
      },
    }));
    setSaveState('idle');
  }

  function handleSave(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (saveState === 'saved') {
      setSaveState('conflict');
      return;
    }

    setSaveState('saved');
  }

  function handleReset(): void {
    setDraft(initialDraft);
    setSaveState('idle');
    setShowPassport(false);
  }

  function renderTextField(
    section: ProfileSection,
    field: string,
    label: string,
    value: string,
    type: 'text' | 'email' | 'date' | 'tel' | 'password' = 'text',
    hint?: string,
  ): JSX.Element {
    return (
      <label className={styles.field} htmlFor={`${section}-${field}`}>
        <span className={styles.fieldLabel}>{label}</span>
        <input
          className={styles.input}
          id={`${section}-${field}`}
          onChange={(event) => updateField(section, field, event.target.value)}
          type={type}
          value={value}
        />
        {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
      </label>
    );
  }

  function renderSelectField(
    section: ProfileSection,
    field: string,
    label: string,
    value: string,
    options: SelectOption[],
  ): JSX.Element {
    return (
      <label className={styles.field} htmlFor={`${section}-${field}`}>
        <span className={styles.fieldLabel}>{label}</span>
        <select
          className={styles.input}
          id={`${section}-${field}`}
          onChange={(event) => updateField(section, field, event.target.value)}
          value={value}
        >
          {options.map((option: SelectOption) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  function renderSectionHeader(section: ProfileSection): JSX.Element {
    const status = sectionStatuses[section];

    return (
      <div className={styles.sectionHeader}>
        <div>
          <div className={styles.sectionTitleRow}>
            <h2>{sectionLabels[section]}</h2>
            <span
              className={`${styles.status} ${status === 'complete' ? styles.statusComplete : styles.statusAttention}`}
            >
              {getSectionStatusLabel(status)}
            </span>
          </div>
          <p>{sectionDescriptions[section]}</p>
        </div>
      </div>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.workspaceHeader}>
          <div className={styles.brandLockup}>
            <div className={styles.brandMark} aria-hidden="true">
              F
            </div>
            <div className={styles.brandCopy}>
              <strong>Flightline workspace</strong>
              <span>Traveler operations</span>
            </div>
          </div>
          <span className={styles.navDivider} aria-hidden="true" />
          <nav className={styles.primaryNav} aria-label="Primary navigation">
            <span className={styles.navItem}>Dashboard</span>
            <span className={styles.navItem}>Search Flights</span>
            <span className={styles.navItem}>My Bookings</span>
            <span className={`${styles.navItem} ${styles.navItemActive}`} aria-current="page">
              Profile
            </span>
          </nav>
          <div className={styles.workspaceControls}>
            <span className={styles.secureBadge}>
              <span className={styles.syncDot} aria-hidden="true" />
              Secure session
            </span>
            <span className={styles.avatarChip} aria-label="Signed in as Maya Chen">
              MC
            </span>
          </div>
        </header>

        <div className={styles.workspaceBar}>
          <nav className={styles.breadcrumb} aria-label="Workspace breadcrumb">
            <span>Workspace</span>
            <span className={styles.breadcrumbSlash} aria-hidden="true">
              /
            </span>
            <span>Traveler profile</span>
          </nav>
          <div className={styles.contextActions} aria-label="Prototype context">
            <span>Readiness workspace</span>
            <span>Local preview</span>
          </div>
        </div>

        <div className={styles.prototypeBanner}>
          <span>Prototype</span>
          <p>Disposable Phase 4 exploration · changes stay in memory</p>
        </div>

        <section className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>Traveler profile</p>
            <h1>Keep every detail ready for takeoff.</h1>
            <p className={styles.heroDescription}>
              Review your identity, contact, document, and travel preferences in one calm, secure
              place.
            </p>
          </div>
          <div className={styles.completionCard} aria-label={`${completion}% profile completion`}>
            <div className={styles.completionHeader}>
              <span>Profile completion</span>
              <strong>{completion}%</strong>
            </div>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${completion}%` }} />
            </div>
            <p>
              {completion === 100
                ? 'Everything is ready.'
                : 'A few details need your attention before an international booking.'}
            </p>
          </div>
        </section>

        <section className={styles.signalStrip} aria-label="Profile health summary">
          <div className={styles.signalItem}>
            <span className={styles.signalLabel}>Profile health</span>
            <strong className={styles.signalValue}>{completion}% ready</strong>
            <span className={styles.signalGood}>On track</span>
          </div>
          <div className={styles.signalItem}>
            <span className={styles.signalLabel}>Open detail</span>
            <strong className={styles.signalValue}>
              {completion === 100 ? 'None' : 'Phone + passport'}
            </strong>
            <span className={styles.signalAccent}>{completion === 100 ? 'Clear' : '2 items'}</span>
          </div>
          <div className={styles.signalItem}>
            <span className={styles.signalLabel}>Privacy posture</span>
            <strong className={styles.signalValue}>Owner-scoped</strong>
            <span className={styles.signalGood}>Protected</span>
          </div>
          <div className={styles.signalItem}>
            <span className={styles.signalLabel}>Revision</span>
            <strong className={styles.signalValue}>01</strong>
            <span className={styles.signalNeutral}>In memory</span>
          </div>
        </section>

        <div className={styles.privacyNotice} role="note">
          <span className={styles.privacyIcon} aria-hidden="true">
            ✓
          </span>
          <div>
            <strong>Your information stays private.</strong>
            <span>
              This prototype never sends or stores these mock values. Production profile responses
              will be no-store and owner-scoped.
            </span>
          </div>
        </div>

        {saveState === 'saved' ? (
          <div className={styles.successAlert} role="status">
            Saved in this prototype. The next save demonstrates how a stale revision is handled.
          </div>
        ) : null}
        {saveState === 'conflict' ? (
          <div className={styles.conflictAlert} role="alert">
            <strong>This profile changed in another tab.</strong>
            <span>
              Reload the latest profile before saving again so no traveler details are overwritten.
            </span>
            <button className="btn-secondary" onClick={handleReset} type="button">
              Reload mock profile
            </button>
          </div>
        ) : null}

        <form className={styles.form} onReset={handleReset} onSubmit={handleSave}>
          <section className={styles.sectionCard}>
            {renderSectionHeader('identity')}
            <div className={styles.fieldGrid}>
              {renderSelectField('identity', 'title', 'Title', draft.identity.title, titleOptions)}
              {renderTextField('identity', 'givenName', 'Given name', draft.identity.givenName)}
              {renderTextField(
                'identity',
                'middleName',
                'Middle name',
                draft.identity.middleName,
                'text',
                'Optional',
              )}
              {renderTextField('identity', 'familyName', 'Family name', draft.identity.familyName)}
              {renderTextField(
                'identity',
                'dateOfBirth',
                'Date of birth',
                draft.identity.dateOfBirth,
                'date',
              )}
              {renderSelectField(
                'identity',
                'gender',
                'Gender',
                draft.identity.gender,
                genderOptions,
              )}
            </div>
          </section>

          <section className={styles.sectionCard}>
            {renderSectionHeader('contact')}
            <div className={styles.fieldGrid}>
              {renderTextField('contact', 'email', 'Email address', draft.contact.email, 'email')}
              <div className={`${styles.field} ${styles.phoneField}`}>
                <span className={styles.fieldLabel}>Phone number</span>
                <div className={styles.phoneControl}>
                  <label className={styles.phoneCountry} htmlFor="contact-phoneCountryCode">
                    <span className={styles.srOnly}>Phone country code</span>
                    <select
                      aria-label="Phone country code"
                      className={styles.input}
                      id="contact-phoneCountryCode"
                      onChange={(event) =>
                        updateField('contact', 'phoneCountryCode', event.target.value)
                      }
                      value={draft.contact.phoneCountryCode}
                    >
                      {phoneCountryOptions.map((option: SelectOption) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={styles.phoneNumber} htmlFor="contact-phoneNumber">
                    <span className={styles.srOnly}>Phone number</span>
                    <input
                      aria-label="Phone number"
                      className={styles.input}
                      id="contact-phoneNumber"
                      onChange={(event) =>
                        updateField('contact', 'phoneNumber', event.target.value)
                      }
                      type="tel"
                      value={draft.contact.phoneNumber}
                    />
                  </label>
                </div>
                <span className={styles.fieldHint}>Required for booking updates</span>
              </div>
            </div>
          </section>

          <section className={`${styles.sectionCard} ${styles.documentSection}`}>
            {renderSectionHeader('travelDocument')}
            <div className={styles.documentSummary}>
              <div>
                <span>Saved document</span>
                <strong>
                  {draft.travelDocument.documentType === 'passport'
                    ? 'Passport'
                    : 'Travel document'}
                </strong>
              </div>
              <div>
                <span>Number</span>
                <strong>{getMaskedPassport(draft.travelDocument.passportNumber)}</strong>
              </div>
              <div>
                <span>Issuing country</span>
                <strong>{draft.travelDocument.issuingCountry || 'Not added'}</strong>
              </div>
              <span className={styles.secureLabel}>Protected field</span>
            </div>
            <div className={styles.fieldGrid}>
              {renderSelectField(
                'travelDocument',
                'documentType',
                'Document type',
                draft.travelDocument.documentType,
                documentOptions,
              )}
              <label className={styles.field} htmlFor="travelDocument-passportNumber">
                <span className={styles.fieldLabel}>Passport number</span>
                <div className={styles.passwordControl}>
                  <input
                    className={styles.input}
                    id="travelDocument-passportNumber"
                    onChange={(event) =>
                      updateField('travelDocument', 'passportNumber', event.target.value)
                    }
                    type={showPassport ? 'text' : 'password'}
                    value={draft.travelDocument.passportNumber}
                  />
                  <button
                    className={styles.showButton}
                    onClick={() => setShowPassport((current: boolean) => !current)}
                    type="button"
                  >
                    {showPassport ? 'Hide' : 'Show'}
                  </button>
                </div>
                <span className={styles.fieldHint}>
                  Visible only while you are editing this secure field.
                </span>
              </label>
              {renderTextField(
                'travelDocument',
                'passportExpiry',
                'Passport expiry',
                draft.travelDocument.passportExpiry,
                'date',
              )}
              {renderSelectField(
                'travelDocument',
                'issuingCountry',
                'Issuing country',
                draft.travelDocument.issuingCountry,
                countryOptions,
              )}
              {renderSelectField(
                'travelDocument',
                'nationality',
                'Nationality',
                draft.travelDocument.nationality,
                countryOptions,
              )}
            </div>
            <div className={styles.documentCallout} role="note">
              <strong>International trip?</strong>
              <span>
                Passport validity is checked again at booking time. Completing this section does not
                guarantee booking readiness.
              </span>
            </div>
          </section>

          <section className={styles.sectionCard}>
            {renderSectionHeader('preferences')}
            <div className={styles.fieldGrid}>
              {renderSelectField(
                'preferences',
                'seatPreference',
                'Seat preference',
                draft.preferences.seatPreference,
                seatOptions,
              )}
              {renderSelectField(
                'preferences',
                'classPreference',
                'Cabin preference',
                draft.preferences.classPreference,
                classOptions,
              )}
            </div>
          </section>

          <div className={styles.actions}>
            <div>
              <strong>Revision 1</strong>
              <span>Last updated just now · Prototype only</span>
            </div>
            <div className={styles.actionButtons}>
              <button className="btn-secondary" onClick={handleReset} type="reset">
                Cancel
              </button>
              <button className="btn-primary" type="submit">
                Save profile
              </button>
            </div>
          </div>
        </form>

        <p className={styles.footerNote}>
          Prototype question: does a single page make it easier to review and correct every traveler
          field?
        </p>
      </div>
    </main>
  );
}
