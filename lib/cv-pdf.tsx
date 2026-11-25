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
import { MASTER_CV } from './master-cv';
import { sanitizeTailoredCV } from './cv-schema';
import type { TailoredCV } from './types';

const NAVY = '#003366';
const INK = '#0f172a';
const BODY = '#1e293b';
const MUTED = '#475569';
const RULE = '#cbd5e1';

const styles = StyleSheet.create({
  page: {
    size: 'A4',
    paddingTop: 36, // 0.5 inch = 36pt
    paddingBottom: 36,
    paddingLeft: 36,
    paddingRight: 36,
    fontFamily: 'Helvetica',
    fontSize: 9.2,
    lineHeight: 1.32,
    color: BODY,
    backgroundColor: '#ffffff',
  },
  header: {
    marginBottom: 10,
    paddingBottom: 7,
    borderBottomWidth: 1.5,
    borderBottomColor: NAVY,
  },
  name: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 20,
    color: NAVY,
    letterSpacing: 0.4,
    marginBottom: 5,
  },
  headline: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 10,
    color: INK,
    marginBottom: 4,
  },
  contactRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    fontSize: 8.5,
    color: MUTED,
  },
  contactItem: {
    color: MUTED,
  },
  contactLink: {
    color: NAVY,
    textDecoration: 'underline',
  },
  contactSep: {
    marginHorizontal: 5,
    color: '#94a3b8',
  },
  section: {
    marginBottom: 9,
  },
  sectionTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 10,
    color: NAVY,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingBottom: 2,
    borderBottomWidth: 0.75,
    borderBottomColor: RULE,
    marginBottom: 5,
  },
  summaryText: {
    fontSize: 9.2,
    lineHeight: 1.36,
    color: BODY,
  },
  roleBlock: {
    marginBottom: 7,
  },
  roleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 2,
  },
  roleLeft: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    maxWidth: '76%',
  },
  roleTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 9.6,
    color: INK,
  },
  roleCompany: {
    fontFamily: 'Helvetica',
    fontSize: 9.4,
    color: NAVY,
  },
  rolePeriod: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 8.5,
    color: MUTED,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 2,
    paddingLeft: 4,
  },
  bulletMark: {
    width: 10,
    fontSize: 9,
    color: NAVY,
    fontFamily: 'Helvetica-Bold',
  },
  bulletText: {
    flex: 1,
    fontSize: 9,
    lineHeight: 1.32,
    color: BODY,
  },
  toolboxRow: {
    flexDirection: 'row',
    marginBottom: 3,
    alignItems: 'flex-start',
  },
  toolboxCategory: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    color: INK,
    width: 132,
  },
  toolboxItems: {
    flex: 1,
    fontSize: 9,
    color: BODY,
    lineHeight: 1.3,
  },
  eduRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 2.5,
  },
  eduText: {
    flex: 1,
    fontSize: 9,
    color: BODY,
    lineHeight: 1.32,
  },
});

function TailoredCvDocument({ cv }: { cv: TailoredCV }) {
  const safeCv = sanitizeTailoredCV(cv);

  return (
    <Document
      title={`${MASTER_CV.name} — CV`}
      author={MASTER_CV.name}
      subject="Tailored Data Analyst Resume"
    >
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header} wrap={false}>
          <Text style={styles.name}>{MASTER_CV.name}</Text>
          <Text style={styles.headline}>{MASTER_CV.title}</Text>
          <View style={styles.contactRow}>
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
          </View>
        </View>

        {/* Professional Summary */}
        <View style={styles.section} wrap={false}>
          <Text style={styles.sectionTitle}>Professional Summary</Text>
          <Text style={styles.summaryText}>{safeCv.summary}</Text>
        </View>

        {/* Professional Experience */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Professional Experience</Text>
          {safeCv.experience.map((item, idx) => (
            <View key={`${item.company}-${idx}`} style={styles.roleBlock} wrap={false}>
              <View style={styles.roleHeader}>
                <View style={styles.roleLeft}>
                  <Text style={styles.roleTitle}>{item.role}</Text>
                  <Text style={styles.roleCompany}>{` — ${item.company}`}</Text>
                </View>
                <Text style={styles.rolePeriod}>{item.period}</Text>
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

        {/* Technical Toolbox */}
        <View style={styles.section} wrap={false}>
          <Text style={styles.sectionTitle}>Technical Toolbox</Text>
          {safeCv.toolbox.map((group, idx) => (
            <View key={`${group.category}-${idx}`} style={styles.toolboxRow}>
              <Text style={styles.toolboxCategory}>{`${group.category}:`}</Text>
              <Text style={styles.toolboxItems}>{group.items}</Text>
            </View>
          ))}
        </View>

        {/* Education */}
        <View style={styles.section} wrap={false}>
          <Text style={styles.sectionTitle}>Education</Text>
          {safeCv.education.map((edu, idx) => (
            <View key={idx} style={styles.eduRow}>
              <Text style={styles.bulletMark}>•</Text>
              <Text style={styles.eduText}>{edu}</Text>
            </View>
          ))}
        </View>
      </Page>
    </Document>
  );
}

export async function renderCvPdfBuffer(cv: TailoredCV): Promise<Buffer> {
  const rendered = await renderToBuffer(<TailoredCvDocument cv={cv} />);
  return Buffer.isBuffer(rendered) ? rendered : Buffer.from(rendered);
}
