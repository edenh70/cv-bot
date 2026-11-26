import React from 'react';
import {
  Document,
  Page,
  Text,
  View,
  Link,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import { sanitizeTailoredCV, sanitizeUploadedMasterCv } from './cv-schema';
import { MASTER_CV } from './master-cv';
import type { TailoredCV } from './types';

export type PdfDensity = 'normal' | 'compact' | 'tight' | 'ultra';

const DEFAULT_NAVY = '#003366';
const INK = '#0f172a';
const BODY = '#1e293b';
const MUTED = '#475569';
const RULE = '#cbd5e1';

interface DensityConfig {
  padding: number;
  baseFont: number;
  nameSize: number;
  headlineSize: number;
  contactSize: number;
  sectionTitleSize: number;
  lineHeight: number;
  sectionGap: number;
  roleGap: number;
  bulletGap: number;
  toolboxWidth: number;
}

const DENSITY_CONFIGS: Record<PdfDensity, DensityConfig> = {
  normal: {
    padding: 34,
    baseFont: 9.2,
    nameSize: 19.5,
    headlineSize: 10,
    contactSize: 8.5,
    sectionTitleSize: 9.8,
    lineHeight: 1.32,
    sectionGap: 8.5,
    roleGap: 6.5,
    bulletGap: 2,
    toolboxWidth: 132,
  },
  compact: {
    padding: 26,
    baseFont: 8.5,
    nameSize: 17.5,
    headlineSize: 9.2,
    contactSize: 8,
    sectionTitleSize: 9,
    lineHeight: 1.24,
    sectionGap: 6.5,
    roleGap: 4.8,
    bulletGap: 1.5,
    toolboxWidth: 124,
  },
  tight: {
    padding: 20,
    baseFont: 7.9,
    nameSize: 16,
    headlineSize: 8.6,
    contactSize: 7.6,
    sectionTitleSize: 8.4,
    lineHeight: 1.16,
    sectionGap: 4.5,
    roleGap: 3.4,
    bulletGap: 1.1,
    toolboxWidth: 116,
  },
  ultra: {
    padding: 18,
    baseFont: 7.5,
    nameSize: 15,
    headlineSize: 8.2,
    contactSize: 7.3,
    sectionTitleSize: 8,
    lineHeight: 1.14,
    sectionGap: 3.8,
    roleGap: 2.8,
    bulletGap: 0.8,
    toolboxWidth: 110,
  },
};

function createDensityStyles(density: PdfDensity, accentColor: string) {
  const cfg = DENSITY_CONFIGS[density];
  return StyleSheet.create({
    page: {
      size: 'A4',
      paddingTop: cfg.padding,
      paddingBottom: cfg.padding,
      paddingLeft: cfg.padding,
      paddingRight: cfg.padding,
      fontFamily: 'Helvetica',
      fontSize: cfg.baseFont,
      lineHeight: cfg.lineHeight,
      color: BODY,
      backgroundColor: '#ffffff',
    },
    header: {
      marginBottom: cfg.sectionGap + 1,
      paddingBottom: 5,
      borderBottomWidth: 1.5,
      borderBottomColor: accentColor,
    },
    name: {
      fontFamily: 'Helvetica-Bold',
      fontSize: cfg.nameSize,
      color: accentColor,
      letterSpacing: 0.35,
      marginBottom: 4,
    },
    headline: {
      fontFamily: 'Helvetica-Bold',
      fontSize: cfg.headlineSize,
      color: INK,
      marginBottom: 3,
    },
    contactRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      fontSize: cfg.contactSize,
      color: MUTED,
    },
    contactItem: {
      color: MUTED,
    },
    contactHeadline: {
      fontFamily: 'Helvetica-Bold',
      color: INK,
    },
    contactLink: {
      color: accentColor,
      textDecoration: 'underline',
    },
    contactSep: {
      marginHorizontal: 4.5,
      color: '#94a3b8',
    },
    section: {
      marginBottom: cfg.sectionGap,
    },
    sectionTitle: {
      fontFamily: 'Helvetica-Bold',
      fontSize: cfg.sectionTitleSize,
      color: accentColor,
      textTransform: 'uppercase',
      letterSpacing: 0.75,
      paddingBottom: 2,
      borderBottomWidth: 0.75,
      borderBottomColor: RULE,
      marginBottom: 4.5,
    },
    summaryText: {
      fontSize: cfg.baseFont,
      lineHeight: cfg.lineHeight + 0.02,
      color: BODY,
    },
    roleBlock: {
      marginBottom: cfg.roleGap,
    },
    roleHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 1.6,
    },
    roleLeft: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      maxWidth: '75%',
    },
    roleTitle: {
      fontFamily: 'Helvetica-Bold',
      fontSize: cfg.baseFont + 0.4,
      color: INK,
    },
    roleCompany: {
      fontFamily: 'Helvetica',
      fontSize: cfg.baseFont + 0.2,
      color: accentColor,
    },
    rolePeriod: {
      fontFamily: 'Helvetica-Bold',
      fontSize: cfg.contactSize,
      color: MUTED,
    },
    bulletRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginBottom: cfg.bulletGap,
      paddingLeft: 4,
    },
    bulletMark: {
      width: 9,
      fontSize: cfg.baseFont,
      color: accentColor,
      fontFamily: 'Helvetica-Bold',
    },
    bulletText: {
      flex: 1,
      fontSize: cfg.baseFont - 0.15,
      lineHeight: cfg.lineHeight,
      color: BODY,
    },
    toolboxRow: {
      flexDirection: 'row',
      marginBottom: cfg.bulletGap + 0.4,
      alignItems: 'flex-start',
    },
    toolboxCategory: {
      fontFamily: 'Helvetica-Bold',
      fontSize: cfg.baseFont - 0.15,
      color: INK,
      width: cfg.toolboxWidth,
    },
    toolboxItems: {
      flex: 1,
      fontSize: cfg.baseFont - 0.15,
      color: BODY,
      lineHeight: cfg.lineHeight,
    },
    eduRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginBottom: cfg.bulletGap + 0.4,
    },
    eduText: {
      flex: 1,
      fontSize: cfg.baseFont - 0.15,
      color: BODY,
      lineHeight: cfg.lineHeight,
    },
    eduBoldLabel: {
      fontFamily: 'Helvetica-Bold',
      color: INK,
    },
  });
}

function renderContactTokens(
  contactLine: string,
  styles: ReturnType<typeof createDensityStyles>,
  prefixTitle?: string,
) {
  const parts = contactLine
    .split(/\s*\|\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

  const tokens = prefixTitle ? [prefixTitle, ...parts] : parts;

  return tokens.map((part, idx) => {
    const isLast = idx === tokens.length - 1;
    let node: React.ReactNode;

    if (prefixTitle && idx === 0) {
      node = <Text style={styles.contactHeadline}>{part}</Text>;
    } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part)) {
      node = (
        <Link src={`mailto:${part}`} style={styles.contactLink}>
          {part}
        </Link>
      );
    } else if (/^https?:\/\//i.test(part)) {
      node = (
        <Link src={part} style={styles.contactLink}>
          {part.replace(/^https?:\/\/(www\.)?/i, '')}
        </Link>
      );
    } else {
      node = <Text style={styles.contactItem}>{part}</Text>;
    }

    return (
      <React.Fragment key={idx}>
        {node}
        {!isLast && <Text style={styles.contactSep}>|</Text>}
      </React.Fragment>
    );
  });
}

function renderEducationLine(
  line: string,
  styles: ReturnType<typeof createDensityStyles>,
) {
  const colonIdx = line.indexOf(':');
  if (colonIdx > 0 && colonIdx < 38) {
    const label = line.slice(0, colonIdx + 1);
    const rest = line.slice(colonIdx + 1);
    return (
      <Text style={styles.eduText}>
        <Text style={styles.eduBoldLabel}>{label}</Text>
        {rest}
      </Text>
    );
  }
  return <Text style={styles.eduText}>{line}</Text>;
}

function TailoredCvDocument({
  cv,
  density,
}: {
  cv: TailoredCV;
  density: PdfDensity;
}) {
  const accentColor =
    cv.layout?.accentColor && /^#[0-9A-Fa-f]{6}$/.test(cv.layout.accentColor)
      ? cv.layout.accentColor
      : DEFAULT_NAVY;

  const styles = createDensityStyles(density, accentColor);
  const displayName = cv.name || MASTER_CV.name;
  const displayTitle = cv.title || MASTER_CV.title;
  const inlineHeader = Boolean(cv.layout?.inlineHeaderContact && cv.contactLine);
  const showSummaryHeading = cv.layout?.hasSummaryHeading ?? true;
  const sectionOrder = cv.layout?.sectionOrder ?? [
    'experience',
    'toolbox',
    'education',
  ];

  const renderSection = (key: 'experience' | 'education' | 'toolbox') => {
    if (key === 'experience' && cv.experience.length > 0) {
      return (
        <View key="experience" style={styles.section}>
          <Text style={styles.sectionTitle}>Professional Experience</Text>
          {cv.experience.map((item, idx) => (
            <View key={`${item.company}-${idx}`} style={styles.roleBlock} wrap={false}>
              <View style={styles.roleHeader}>
                <View style={styles.roleLeft}>
                  <Text style={styles.roleTitle}>{item.role}</Text>
                  {item.company ? (
                    <Text style={styles.roleCompany}>{` — ${item.company}`}</Text>
                  ) : null}
                </View>
                {item.period ? <Text style={styles.rolePeriod}>{item.period}</Text> : null}
              </View>
              {item.bullets.map((bullet, bIdx) => (
                <View key={bIdx} style={styles.bulletRow}>
                  <Text style={styles.bulletMark}>•</Text>
                  <Text style={styles.bulletText}>{bullet}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      );
    }

    if (key === 'toolbox' && cv.toolbox.length > 0) {
      return (
        <View key="toolbox" style={styles.section} wrap={false}>
          <Text style={styles.sectionTitle}>Technical Toolbox</Text>
          {cv.toolbox.map((group, idx) => (
            <View key={`${group.category}-${idx}`} style={styles.toolboxRow}>
              <Text style={styles.toolboxCategory}>{`${group.category}:`}</Text>
              <Text style={styles.toolboxItems}>{group.items}</Text>
            </View>
          ))}
        </View>
      );
    }

    if (key === 'education' && cv.education.length > 0) {
      return (
        <View key="education" style={styles.section} wrap={false}>
          <Text style={styles.sectionTitle}>Education</Text>
          {cv.education.map((edu, idx) => {
            const hasBoldLabel = edu.indexOf(':') > 0 && edu.indexOf(':') < 38;
            return (
              <View key={idx} style={styles.eduRow}>
                {!hasBoldLabel && <Text style={styles.bulletMark}>•</Text>}
                {renderEducationLine(edu, styles)}
              </View>
            );
          })}
        </View>
      );
    }

    return null;
  };

  return (
    <Document
      title={`${displayName} — CV`}
      author={displayName}
      subject="Tailored Data Analyst Resume"
    >
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header} wrap={false}>
          <Text style={styles.name}>{displayName}</Text>
          {!inlineHeader && displayTitle ? (
            <Text style={styles.headline}>{displayTitle}</Text>
          ) : null}
          <View style={styles.contactRow}>
            {cv.contactLine ? (
              renderContactTokens(
                cv.contactLine,
                styles,
                inlineHeader ? displayTitle : undefined,
              )
            ) : (
              <>
                <Text style={styles.contactItem}>{MASTER_CV.contact.location}</Text>
                <Text style={styles.contactSep}>|</Text>
                <Link src={`mailto:${MASTER_CV.contact.email}`} style={styles.contactLink}>
                  {MASTER_CV.contact.email}
                </Link>
                <Text style={styles.contactSep}>|</Text>
                <Text style={styles.contactItem}>{MASTER_CV.contact.phone}</Text>
                <Text style={styles.contactSep}>|</Text>
                {MASTER_CV.contact.linkedinUrl ? (
                  <Link src={MASTER_CV.contact.linkedinUrl} style={styles.contactLink}>
                    {MASTER_CV.contact.linkedinLabel}
                  </Link>
                ) : (
                  <Text style={styles.contactItem}>{MASTER_CV.contact.linkedinLabel}</Text>
                )}
                <Text style={styles.contactSep}>|</Text>
                {MASTER_CV.contact.githubUrl ? (
                  <Link src={MASTER_CV.contact.githubUrl} style={styles.contactLink}>
                    {MASTER_CV.contact.githubLabel}
                  </Link>
                ) : (
                  <Text style={styles.contactItem}>{MASTER_CV.contact.githubLabel}</Text>
                )}
              </>
            )}
          </View>
        </View>

        {/* Summary (with or without heading matching user's template) */}
        {cv.summary ? (
          <View style={styles.section} wrap={false}>
            {showSummaryHeading && (
              <Text style={styles.sectionTitle}>Professional Summary</Text>
            )}
            <Text style={styles.summaryText}>{cv.summary}</Text>
          </View>
        ) : null}

        {/* Ordered Main Sections */}
        {sectionOrder.map((secKey) => renderSection(secKey))}

        {/* Extra Sections (Languages, Military Service, Projects, etc.) */}
        {(cv.extraSections ?? []).map((sec, idx) => (
          <View key={`${sec.title}-${idx}`} style={styles.section} wrap={false}>
            <Text style={styles.sectionTitle}>{sec.title}</Text>
            {sec.items.map((item, iIdx) => (
              <View key={iIdx} style={styles.eduRow}>
                <Text style={styles.bulletMark}>•</Text>
                <Text style={styles.eduText}>{item}</Text>
              </View>
            ))}
          </View>
        ))}
      </Page>
    </Document>
  );
}

export async function renderCvPdfBuffer(
  cv: TailoredCV,
  options?: {
    density?: PdfDensity;
    masterTemplate?: TailoredCV;
    preserveUploadedShape?: boolean;
  },
): Promise<Buffer> {
  const safeCv = options?.preserveUploadedShape
    ? sanitizeUploadedMasterCv(cv)
    : sanitizeTailoredCV(cv, options?.masterTemplate);
  const density = options?.density ?? 'normal';
  const rendered = await renderToBuffer(
    <TailoredCvDocument cv={safeCv} density={density} />,
  );
  return Buffer.isBuffer(rendered) ? rendered : Buffer.from(rendered);
}
