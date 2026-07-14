// Litigation drafting template library.
// Each template carries an `id` (stable slug for favorites/recents), a `preset`
// (drives editor + DOCX styling), variables prefilled from matter context, and
// a prompt with {{token}} substitution.

import {
  Mail,
  Gavel,
  FileSignature,
  ListChecks,
  CalendarClock,
  FileSearch,
  ClipboardList,
  Scale,
  Users,
  Search,
  Shield,
  BookOpen,
  Briefcase,
  MessageSquare,
  Timer,
  FileText,
  Landmark,
  Ban,
  Scroll,
  UserCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PresetId } from './format-presets';

export type TemplateCategory =
  | 'Correspondence'
  | 'Motions & Briefs'
  | 'Discovery'
  | 'Case Management'
  | 'Hearing Prep'
  | 'Leadership / PSC';

export type VarSource =
  | 'matter.judge'
  | 'matter.court'
  | 'matter.mdl_number'
  | 'matter.short_name'
  | 'matter.name'
  | 'today'
  | 'user';

export type TemplateVar = {
  key: string;
  label: string;
  placeholder?: string;
  source?: VarSource; // if set, prefilled from matter/context; user is a manual field
  default?: string;
};

export type DraftTemplate = {
  id: string;
  category: TemplateCategory;
  icon: LucideIcon;
  title: string;
  docType: string;
  summary: string;
  preset: PresetId;
  vars: TemplateVar[];
  prompt: string;
};

// Common variable definitions (referenced by many templates).
const V_MATTER = {
  key: 'matter',
  label: 'Matter',
  source: 'matter.name' as const,
};
const V_MDL = { key: 'mdl', label: 'MDL number', source: 'matter.mdl_number' as const };
const V_JUDGE = { key: 'judge', label: 'Judge', source: 'matter.judge' as const };
const V_COURT = { key: 'court', label: 'Court', source: 'matter.court' as const };
const V_DATE = { key: 'date', label: 'Date', source: 'today' as const };
const V_ATTY = {
  key: 'attorney',
  label: 'Attorney name',
  source: 'user' as const,
  placeholder: 'e.g. Firas J. Kalash',
};
const V_OPP = {
  key: 'opposing',
  label: 'Opposing party',
  source: 'user' as const,
  placeholder: 'e.g. Pfizer, Inc.',
};
const V_SUBJECT = {
  key: 'subject',
  label: 'Subject / Re:',
  source: 'user' as const,
  placeholder: 'e.g. Deficient responses to RFPs 12–24',
};
const V_DEADLINE = {
  key: 'deadline',
  label: 'Deadline',
  source: 'user' as const,
  placeholder: 'e.g. 30 days from service',
};

export const DRAFT_TEMPLATES: DraftTemplate[] = [
  // ================= Correspondence =================
  {
    id: 'letter-meet-confer',
    category: 'Correspondence',
    icon: Mail,
    title: 'Meet-and-confer letter',
    docType: 'Letter',
    preset: 'letter',
    summary: 'Discovery deficiencies, numbered, tied to the controlling order.',
    vars: [V_DATE, V_ATTY, V_OPP, V_SUBJECT],
    prompt:
      'Draft a meet-and-confer letter from Seeger Weiss LLP to counsel for {{opposing}} regarding "{{subject}}". Full letter form dated {{date}}: addressee block, "Re: {{matter}}, MDL No. {{mdl}} — {{subject}}", salutation, body organized as numbered deficiency items each citing the controlling discovery order and the specific request at issue, a proposal of meet-and-confer times within the next seven days, and a closing signature block for {{attorney}}, Seeger Weiss LLP. Reserve all rights. Insert [BRACKETED ALL-CAPS] placeholders for any fact not in the record.',
  },
  {
    id: 'letter-magistrate',
    category: 'Correspondence',
    icon: Mail,
    title: 'Letter to Magistrate Judge',
    docType: 'Letter',
    preset: 'letter',
    summary: 'Pre-motion discovery dispute letter per the operative procedure.',
    vars: [V_ATTY, V_SUBJECT],
    prompt:
      'Draft a pre-motion discovery dispute letter to {{judge}} following the procedure set out in the operative discovery management order. Brief letter form with subject line "Re: {{matter}}, MDL No. {{mdl}} — {{subject}}", three to four short numbered paragraphs stating (1) the dispute, (2) what plaintiffs sought and when, (3) defendants\' position and meet-and-confer efforts, and (4) the limited relief requested. Cite the controlling order. Sign "Respectfully submitted," with {{attorney}}, Seeger Weiss LLP.',
  },
  {
    id: 'letter-rule37',
    category: 'Correspondence',
    icon: Mail,
    title: 'Rule 37 pre-motion letter',
    docType: 'Letter',
    preset: 'letter',
    summary: 'Formal Rule 37 pre-motion certification letter.',
    vars: [V_ATTY, V_OPP, V_SUBJECT],
    prompt:
      'Draft a Rule 37 pre-motion letter to counsel for {{opposing}} that will support the certification requirement of Fed. R. Civ. P. 37(a)(1). Formal letter form. Sections: (1) chronology of meet-and-confer efforts with dates; (2) specific requests / responses at issue; (3) legal deficiencies with citations to the operative discovery order and Rule 26/34; (4) a fourteen-day deadline to cure with a specific list of acts required; (5) reservation of rights, including a Rule 37 motion and fee-shifting. Signature block for {{attorney}}, Seeger Weiss LLP.',
  },
  {
    id: 'letter-extension',
    category: 'Correspondence',
    icon: Timer,
    title: 'Extension request letter',
    docType: 'Letter',
    preset: 'letter',
    summary: 'Short professional courtesy extension request.',
    vars: [V_ATTY, V_OPP, V_DEADLINE, V_SUBJECT],
    prompt:
      'Draft a short, courteous letter to counsel for {{opposing}} requesting a professional-courtesy extension on {{subject}}. State the current deadline, the length of extension requested ({{deadline}}), the good cause supporting it, that this is the first (or state which) such request, and that opposing counsel\'s prior extensions will be reciprocated. Sign {{attorney}}, Seeger Weiss LLP.',
  },
  {
    id: 'letter-preservation',
    category: 'Correspondence',
    icon: Shield,
    title: 'Litigation hold / preservation letter',
    docType: 'Letter',
    preset: 'letter',
    summary: 'Preservation demand to defense counsel with custodian list.',
    vars: [V_ATTY, V_OPP],
    prompt:
      'Draft a litigation hold / preservation demand letter from Seeger Weiss LLP to counsel for {{opposing}}. Sections: (1) obligation to preserve under Fed. R. Civ. P. 37(e) and Eleventh Circuit authority; (2) scope — all documents, ESI, communications, structured data, and physical materials relating to the medroxyprogesterone acetate meningioma signal, label decisions, pharmacovigilance, and post-marketing surveillance; (3) custodian and data-source list as a bulleted skeleton (leadership, regulatory, safety, medical affairs, marketing, IT, third-party vendors); (4) suspension of routine deletion / retention policies; (5) confirmation demand within fourteen days. Signature block for {{attorney}}.',
  },

  // ================= Motions & Briefs =================
  {
    id: 'motion-compel',
    category: 'Motions & Briefs',
    icon: Gavel,
    title: 'Motion to compel discovery',
    docType: 'Motion',
    preset: 'federal-motion',
    summary: 'Full brief with argument headings and proposed relief.',
    vars: [V_ATTY, V_OPP, V_SUBJECT],
    prompt:
      'Draft a full Plaintiffs\' Motion to Compel Discovery targeting {{opposing}} on the issue of {{subject}}. Full court caption for {{court}}, before {{judge}}. Title "PLAINTIFFS\' MOTION TO COMPEL DISCOVERY". Sections in order: Introduction; Background (meet-and-confer chronology with pin cites); Legal Standard (Fed. R. Civ. P. 26(b)(1) and 37(a); Eleventh Circuit authority); Argument with numbered headings (I., II., A., B.) — each attacking a specific deficiency and citing the operative discovery order; Conclusion and Proposed Relief with a numbered list of specific compelled acts; signature block for {{attorney}}, Seeger Weiss LLP; Certificate of Conferral; Certificate of Service. Use [BRACKETED ALL-CAPS] placeholders for record pin cites and factual specifics not in the record.',
  },
  {
    id: 'brief-daubert-response',
    category: 'Motions & Briefs',
    icon: Scale,
    title: 'Daubert / Rule 702 response',
    docType: 'Brief',
    preset: 'federal-brief',
    summary: 'General-causation expert defense for the gating hearing.',
    vars: [V_ATTY, { key: 'expert', label: 'Expert', source: 'user', placeholder: 'e.g. Dr. Susan Ellis' }],
    prompt:
      'Draft a Plaintiffs\' Response in Opposition to Defendants\' Rule 702 / Daubert Motion challenging {{expert}} on the general-causation issue linking long-term medroxyprogesterone acetate exposure to intracranial meningioma. Full caption for {{court}}. Numbered sections: I. Introduction; II. Legal Standard (Rule 702, as amended in 2023; Daubert; Kumho Tire; Eleventh Circuit gatekeeping); III. {{expert}}\'s Methodology Satisfies Rule 702 (A. Reliability — subheadings for study design, weight-of-evidence, Bradford Hill; B. Fit; C. Qualifications); IV. Defendants\' Critiques Go to Weight, Not Admissibility; V. Conclusion. Bluebook throughout. Bracketed pin-cite placeholders for expert report and deposition.',
  },
  {
    id: 'motion-in-limine',
    category: 'Motions & Briefs',
    icon: Ban,
    title: 'Motion in limine',
    docType: 'Motion',
    preset: 'federal-motion',
    summary: 'Numbered MIL — one order, multiple grounds.',
    vars: [V_ATTY, V_SUBJECT],
    prompt:
      'Draft Plaintiffs\' Omnibus Motion in Limine for the bellwether trial. Full caption. Title. Introduction. Then a series of numbered motions (MIL No. 1, MIL No. 2, …) each with (a) evidence sought to be excluded, (b) governing rule (FRE 401/402/403/404/407/408/701/702), (c) three to five sentences of argument, (d) proposed order language. Sample motions to include: state-of-the-art defense evidence post-dating exposure, learned-intermediary anecdotes, financial condition of plaintiffs, absence of prior verdicts, unrelated FDA actions. End with proposed order and signature block for {{attorney}}.',
  },
  {
    id: 'motion-protective-order',
    category: 'Motions & Briefs',
    icon: Shield,
    title: 'Motion for protective order',
    docType: 'Motion',
    preset: 'federal-motion',
    summary: 'Rule 26(c) protective order motion with proportionality argument.',
    vars: [V_ATTY, V_OPP, V_SUBJECT],
    prompt:
      'Draft a Plaintiffs\' Motion for a Protective Order under Fed. R. Civ. P. 26(c) responding to {{opposing}}\'s {{subject}}. Full caption. Sections: I. Introduction; II. Background; III. Legal Standard (Rule 26(c), good cause, proportionality under 26(b)(1)); IV. Argument (A. undue burden; B. relevance; C. proportionality with the Sedona-style factors); V. Proposed Relief. Signature block for {{attorney}}; certificate of conferral; certificate of service.',
  },
  {
    id: 'motion-502d',
    category: 'Motions & Briefs',
    icon: BookOpen,
    title: 'FRE 502(d) motion',
    docType: 'Motion',
    preset: 'federal-motion',
    summary: 'Non-waiver order to speed production.',
    vars: [V_ATTY],
    prompt:
      'Draft a Joint Motion for Entry of a Federal Rule of Evidence 502(d) Non-Waiver Order in {{matter}}. Full caption. Short brief: (1) legal standard; (2) benefits — speeds production, controls cost, avoids collateral disputes; (3) proposed order paragraphs (attachment) providing that production of privileged material in this action shall not operate as a waiver in this or any other federal or state proceeding, regardless of the care taken. Signature blocks for both sides; {{attorney}} for Plaintiffs.',
  },
  {
    id: 'motion-sanctions',
    category: 'Motions & Briefs',
    icon: Gavel,
    title: 'Motion for sanctions',
    docType: 'Motion',
    preset: 'federal-motion',
    summary: 'Rule 37 sanctions motion for discovery abuse.',
    vars: [V_ATTY, V_OPP, V_SUBJECT],
    prompt:
      'Draft a Plaintiffs\' Motion for Sanctions against {{opposing}} under Fed. R. Civ. P. 37 for {{subject}}. Full caption. Sections: I. Introduction; II. Factual Background (detailed timeline of the discovery abuse with record pin cites); III. Legal Standard (Rule 37(b), (c), (e); Eleventh Circuit sanctions authority); IV. Argument — subsections requesting each escalating remedy: (A) evidentiary sanctions, (B) adverse-inference instruction, (C) monetary sanctions and attorneys\' fees, (D) issue preclusion; V. Proposed Relief. Signature block for {{attorney}}.',
  },
  {
    id: 'brief-opp-mtd',
    category: 'Motions & Briefs',
    icon: Scale,
    title: 'Opposition to motion to dismiss',
    docType: 'Brief',
    preset: 'federal-brief',
    summary: '12(b)(6) opposition addressing preemption and TwIqbal.',
    vars: [V_ATTY],
    prompt:
      'Draft Plaintiffs\' Opposition to Defendants\' Motion to Dismiss the Master Complaint in {{matter}}. Full caption. Sections: I. Introduction; II. Background; III. Legal Standard (Twombly/Iqbal); IV. Argument — subsections addressing (A) failure to warn survives under Wyeth v. Levine; (B) design defect; (C) implied preemption limits; (D) generic defendants (Mensing / Bartlett) if applicable; (E) statute of limitations / discovery rule; V. Conclusion. Bluebook throughout; bracketed placeholders for jurisdiction-specific choice-of-law issues.',
  },
  {
    id: 'brief-reply',
    category: 'Motions & Briefs',
    icon: MessageSquare,
    title: 'Reply in support of motion',
    docType: 'Brief',
    preset: 'federal-brief',
    summary: 'Short, tight reply that concedes nothing and reframes.',
    vars: [V_ATTY, V_SUBJECT],
    prompt:
      'Draft Plaintiffs\' Reply in Support of {{subject}}. Short, tight brief. Full caption. Sections: I. Introduction (three sentences, reframes the issue); II. Argument — three numbered subsections, each opening by restating Defendants\' argument in one sentence and then dismantling it with authority and record cites; III. Conclusion (single paragraph, specific relief). Signature block for {{attorney}}. Do not repeat the opening brief; assume the Court has read it.',
  },
  {
    id: 'response-lone-pine',
    category: 'Motions & Briefs',
    icon: Scale,
    title: 'Response to Lone Pine motion',
    docType: 'Brief',
    preset: 'federal-brief',
    summary: 'Opposition to a Lone Pine case-management order.',
    vars: [V_ATTY],
    prompt:
      'Draft Plaintiffs\' Response in Opposition to Defendants\' Motion for a Lone Pine Order in {{matter}}. Full caption. Sections: I. Introduction; II. Background — PFS regime and case inventory; III. Legal Standard (Acuna v. Brown & Root; In re Vioxx; Eleventh Circuit / N.D. Fla. authority); IV. Argument — (A) the existing PFS + PPF regime already screens claims; (B) a Lone Pine order is premature before general causation is resolved; (C) the burden is unwarranted and disproportionate; (D) plaintiffs will be prejudiced; V. Conclusion. Cite the operative PTOs and CMOs by number.',
  },

  // ================= Discovery =================
  {
    id: 'disc-rfps',
    category: 'Discovery',
    icon: FileSignature,
    title: "Plaintiffs' First RFPs",
    docType: 'Discovery Request',
    preset: 'discovery',
    summary: 'Numbered RFPs with definitions and instructions block.',
    vars: [V_ATTY],
    prompt:
      'Draft Plaintiffs\' First Set of Requests for Production to Defendants in {{matter}}, MDL No. {{mdl}}. Full caption. Sections: I. Definitions; II. Instructions (Fed. R. Civ. P. 26/34 and the operative ESI protocol); III. Requests numbered RFP No. 1–30 covering general-causation research, pharmacovigilance signals on meningioma, label change history, FDA correspondence, internal risk assessments, sales and marketing training, physician communications, and post-marketing surveillance. Each request on one substantive item. Signature block for {{attorney}}.',
  },
  {
    id: 'disc-rogs',
    category: 'Discovery',
    icon: FileSignature,
    title: "Plaintiffs' First Interrogatories",
    docType: 'Discovery Request',
    preset: 'discovery',
    summary: 'Rule 33 rogs with definitions, capped at 25.',
    vars: [V_ATTY],
    prompt:
      'Draft Plaintiffs\' First Set of Interrogatories to Defendants in {{matter}}. Full caption. Definitions and instructions block. Twenty-five numbered interrogatories, subparts counted (Fed. R. Civ. P. 33(a)(1)), covering: corporate structure, custodian identification, safety-signal reporting, label-change decision-making, FDA communications regarding meningioma, internal committee minutes, and identification of witnesses with knowledge of the safer-alternative (Depo-SubQ Provera 104) analysis. Signature block for {{attorney}}.',
  },
  {
    id: 'disc-rfas',
    category: 'Discovery',
    icon: FileSignature,
    title: 'Requests for admission',
    docType: 'Discovery Request',
    preset: 'discovery',
    summary: 'Rule 36 RFAs — one fact each.',
    vars: [V_ATTY],
    prompt:
      'Draft Plaintiffs\' First Set of Requests for Admission under Fed. R. Civ. P. 36. Full caption. Definitions and instructions. Numbered RFAs — each requesting admission of a single discrete fact regarding: authenticity and business-record status of enumerated documents, corporate structure, label-change dates, FDA correspondence dates, and internal awareness of the meningioma signal. Signature block for {{attorney}}.',
  },
  {
    id: 'disc-30b6',
    category: 'Discovery',
    icon: Users,
    title: '30(b)(6) deposition notice',
    docType: 'Notice',
    preset: 'discovery',
    summary: 'Rule 30(b)(6) topics list with defined scope.',
    vars: [V_ATTY, V_OPP],
    prompt:
      'Draft a Notice of Videotaped Rule 30(b)(6) Deposition of {{opposing}} in {{matter}}. Full caption. Sections: (1) time / place / method; (2) definitions; (3) enumerated topics, drafted with reasonable particularity per Fed. R. Civ. P. 30(b)(6), covering: pharmacovigilance systems, safety-signal detection processes, labeling committees and decisions, communications with FDA regarding meningioma, comparative marketing of Depo-SubQ Provera 104, and document-retention policies. Instruction to designate one or more persons and provide the designee list fourteen days in advance. Signature block for {{attorney}}.',
  },
  {
    id: 'disc-subpoena',
    category: 'Discovery',
    icon: Scroll,
    title: 'Subpoena duces tecum',
    docType: 'Subpoena',
    preset: 'discovery',
    summary: 'Rule 45 subpoena with attached schedule.',
    vars: [V_ATTY],
    prompt:
      'Draft a Rule 45 subpoena duces tecum to a non-party (placeholder [NON-PARTY]) in {{matter}}. AO 88B caption. Cover page followed by Schedule A: definitions, instructions, and numbered document requests. Include the notice provisions required by Rule 45(a)(4). Sign for {{attorney}}, Seeger Weiss LLP.',
  },
  {
    id: 'disc-priv-log',
    category: 'Discovery',
    icon: FileText,
    title: 'Privilege log skeleton',
    docType: 'Privilege Log',
    preset: 'outline',
    summary: 'Metadata + rationale table per the operative protocol.',
    vars: [V_ATTY],
    prompt:
      'Draft a privilege log skeleton for {{matter}}. Header identifying producing party, date, and version. Markdown table with columns: Bates | Date | From | To | CC | Type | Subject | Privilege Claimed | Basis. Include one worked example row per privilege type (attorney-client, work product, common-interest). Add a footer note tracking the metadata fields required by the operative ESI protocol.',
  },
  {
    id: 'disc-pfs-cover',
    category: 'Discovery',
    icon: UserCheck,
    title: 'Plaintiff Fact Sheet cover',
    docType: 'Cover',
    preset: 'letter',
    summary: 'Cover letter for a PFS production.',
    vars: [V_ATTY, V_OPP],
    prompt:
      'Draft a cover letter transmitting Plaintiff\'s completed Plaintiff Fact Sheet and authorizations to {{opposing}} pursuant to the operative CMO. Confirm compliance with the PFS deadline, list attachments, note any items in production and any objections preserved. Sign {{attorney}}, Seeger Weiss LLP.',
  },

  // ================= Case Management =================
  {
    id: 'cmo-status',
    category: 'Case Management',
    icon: ListChecks,
    title: 'Joint status report',
    docType: 'Status Report',
    preset: 'federal-motion',
    summary: 'Pre-CMC status report to the Court.',
    vars: [V_ATTY],
    prompt:
      'Draft a Joint Status Report to {{judge}} ahead of the next status conference in {{matter}}. Full caption. Numbered sections: I. Case Inventory; II. Plaintiff/Defendant Fact Sheets; III. Document Discovery; IV. Deposition Schedule; V. Expert Discovery / Daubert; VI. Bellwether Process; VII. Pending Motions; VIII. Proposed Agenda. Use joint voice; add "Plaintiffs\' Position:" / "Defendants\' Position:" subheads where the parties disagree. Dual signature block; {{attorney}} for Plaintiffs.',
  },
  {
    id: 'cmo-deadline-memo',
    category: 'Case Management',
    icon: CalendarClock,
    title: 'Deadline & obligations summary',
    docType: 'Memo',
    preset: 'internal-memo',
    summary: 'Tabular summary of upcoming CMO obligations.',
    vars: [V_ATTY],
    prompt:
      'Draft a memorandum summarizing upcoming deadlines and each party\'s obligations under the operative case management order in {{matter}}. Memo header (TO / FROM / DATE / RE). Section 1: markdown table "Date | Event | Source (PTO/CMO ¶) | Plaintiffs\' Obligation | Defendants\' Obligation". Section 2: narrative of the three most significant deadlines with strategic implications. Cite each row to the controlling order.',
  },
  {
    id: 'cmo-26f',
    category: 'Case Management',
    icon: ListChecks,
    title: 'Rule 26(f) report',
    docType: 'Report',
    preset: 'federal-motion',
    summary: 'Joint Rule 26(f) discovery plan and report.',
    vars: [V_ATTY],
    prompt:
      'Draft a Joint Rule 26(f) Report and Discovery Plan for {{matter}}. Full caption. Sections mirroring the Rule 26(f) categories: (1) initial disclosures; (2) subjects, scope, and phasing of discovery; (3) ESI protocol; (4) claims of privilege / 502(d); (5) discovery limits; (6) proposed schedule with dates; (7) other orders. Add "Plaintiffs\' Position" / "Defendants\' Position" callouts wherever the parties differ. Signature block for {{attorney}}.',
  },
  {
    id: 'cmo-bellwether',
    category: 'Case Management',
    icon: Landmark,
    title: 'Bellwether selection proposal',
    docType: 'Proposal',
    preset: 'federal-motion',
    summary: 'Plaintiffs\' proposal for bellwether pool and selection method.',
    vars: [V_ATTY],
    prompt:
      'Draft Plaintiffs\' Proposed Bellwether Selection Protocol for {{matter}}. Full caption. Sections: I. Introduction; II. Governing Authority (Manual for Complex Litigation §22.315); III. Proposed Pool Size and Selection Criteria; IV. Discovery Schedule for Bellwether Pool (PFS, records, expert selection); V. Case-Specific Discovery Timeline; VI. Trial-Ready Pool Reduction; VII. Proposed Order attachment. Present the selection method as a numbered protocol.',
  },

  // ================= Hearing Prep =================
  {
    id: 'hearing-bench-memo',
    category: 'Hearing Prep',
    icon: FileSearch,
    title: 'Bench memo',
    docType: 'Bench Memo',
    preset: 'bench-memo',
    summary: 'Internal bench memo for an upcoming hearing.',
    vars: [V_ATTY, V_SUBJECT],
    prompt:
      'Draft an internal bench memo for Plaintiffs\' co-lead counsel preparing for an upcoming hearing on {{subject}} before {{judge}}. Header MEMORANDUM with TO / FROM / DATE / RE. Sections: I. Question Presented; II. Short Answer; III. Background; IV. Discussion (I., A., B.); V. Anticipated Questions from the Court; VI. Talking Points; VII. Follow-up. Bluebook throughout. [BRACKETED ALL-CAPS] placeholders for record cites.',
  },
  {
    id: 'hearing-cross-outline',
    category: 'Hearing Prep',
    icon: FileSearch,
    title: 'Cross-examination outline',
    docType: 'Outline',
    preset: 'outline',
    summary: 'Topic-driven cross of a defense expert.',
    vars: [{ key: 'witness', label: 'Witness', source: 'user', placeholder: 'Defense expert' }],
    prompt:
      'Draft a cross-examination outline for {{witness}}, a defense general-causation expert in {{matter}}. Header with witness name, role, date. Sections by topic (I., II., III.), subtopics (A., B.), numbered questions with anticipated answer in italics and exhibit references. End with "Loose Ends" and "Impeachment Reserves".',
  },
  {
    id: 'hearing-direct-outline',
    category: 'Hearing Prep',
    icon: Users,
    title: 'Direct-examination outline',
    docType: 'Outline',
    preset: 'outline',
    summary: 'Story-driven direct of a plaintiffs\' expert.',
    vars: [{ key: 'witness', label: 'Witness', source: 'user', placeholder: 'Plaintiffs\' expert' }],
    prompt:
      'Draft a direct-examination outline for {{witness}}, Plaintiffs\' general-causation expert in {{matter}}. Header with witness name, qualifications summary, and demonstrative list. Sections: I. Qualifications; II. Assignment; III. Methodology (open-ended narrative questions); IV. Key Findings; V. Response to Defense Critiques; VI. Conclusions. Numbered questions written to invite narrative answers with anticipated demonstrative cues in brackets.',
  },
  {
    id: 'hearing-oral-arg',
    category: 'Hearing Prep',
    icon: MessageSquare,
    title: 'Oral argument outline',
    docType: 'Outline',
    preset: 'outline',
    summary: 'Three-theme outline with anticipated bench questions.',
    vars: [V_SUBJECT],
    prompt:
      'Draft an oral argument outline for Plaintiffs on {{subject}} before {{judge}}. Header: caption, courtroom, argument time. Sections: I. Roadmap (three themes, one sentence each); II. Theme One — with authorities and record cites; III. Theme Two; IV. Theme Three; V. Anticipated Questions from the Bench with prepared answers; VI. Reserved-Time Talking Points; VII. Closing. Bold call-outs for hot cases.',
  },
  {
    id: 'hearing-daubert-prep',
    category: 'Hearing Prep',
    icon: Scale,
    title: 'Daubert hearing prep memo',
    docType: 'Memo',
    preset: 'bench-memo',
    summary: 'Internal prep memo for the Rule 702 hearing.',
    vars: [V_ATTY],
    prompt:
      'Draft an internal preparation memorandum for Plaintiffs\' team preparing for the Rule 702 / Daubert hearing in {{matter}}. Memo header. Sections: I. Governing Framework (Rule 702 as amended in 2023; Daubert; Kumho); II. Our Experts (short profile + methodology summary each); III. Their Experts (planned attacks); IV. Anticipated Judicial Questions; V. Demonstratives and Exhibits list; VI. Assignments (who argues what); VII. Contingencies. [BRACKETED ALL-CAPS] placeholders.',
  },

  // ================= Leadership / PSC =================
  {
    id: 'psc-common-benefit',
    category: 'Leadership / PSC',
    icon: ClipboardList,
    title: 'Common-benefit time memo',
    docType: 'PSC Memo',
    preset: 'internal-memo',
    summary: 'Submission instructions to participating firms.',
    vars: [],
    prompt:
      'Draft a memorandum from Plaintiffs\' Co-Lead Counsel to all participating firms in {{matter}} setting procedures for submitting common-benefit time and expenses under the operative Common Benefit Order. Memo header. Sections: I. Authority; II. What Qualifies; III. Time Submission Procedure; IV. Expense Submission Procedure; V. Audit and Approval; VI. Contact.',
  },
  {
    id: 'psc-agenda',
    category: 'Leadership / PSC',
    icon: Briefcase,
    title: 'PSC meeting agenda',
    docType: 'Agenda',
    preset: 'internal-memo',
    summary: 'Structured PSC agenda with time allotments.',
    vars: [V_DATE],
    prompt:
      'Draft a Plaintiffs\' Steering Committee meeting agenda for {{matter}} dated {{date}}. Header: meeting time, dial-in placeholder, chairs. Numbered agenda items with time allotments, owners, and outcome sought. Standard sections: I. Case Inventory Update; II. Discovery Status; III. Depositions Calendar; IV. Expert / Daubert; V. Motions in Flight; VI. Leadership Announcements; VII. Committee Reports (Discovery, Law & Briefing, Science, Bellwether); VIII. Common Benefit; IX. Next Steps and Action Items.',
  },
  {
    id: 'psc-tplf-memo',
    category: 'Leadership / PSC',
    icon: Search,
    title: 'TPLF disclosure memo',
    docType: 'PSC Memo',
    preset: 'internal-memo',
    summary: 'Internal memo on third-party litigation funding disclosure.',
    vars: [],
    prompt:
      'Draft an internal memorandum from Plaintiffs\' Co-Lead Counsel to participating firms in {{matter}} regarding third-party litigation funding (TPLF) disclosure obligations. Memo header. Sections: I. Background (any local rule / standing order / CMO obligations); II. Scope of Disclosure Required (identity of funder, terms, control provisions); III. Process for Providing Disclosures to Lead Counsel; IV. Confidentiality Protections; V. Deadline and Contact.',
  },
];

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  'Correspondence',
  'Motions & Briefs',
  'Discovery',
  'Case Management',
  'Hearing Prep',
  'Leadership / PSC',
];

// Variable substitution — replaces {{key}} tokens with resolved values.
export function resolveTemplatePrompt(
  tpl: DraftTemplate,
  values: Record<string, string>,
): string {
  return tpl.prompt.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = values[k];
    if (v && v.trim()) return v.trim();
    // Fall back to a bracketed placeholder so the model knows to prompt the user.
    const varDef = tpl.vars.find((x) => x.key === k);
    return `[${(varDef?.label ?? k).toUpperCase()}]`;
  });
}

// Build the default values from matter context + today.
export function buildDefaultVars(matter: {
  name: string;
  short_name: string;
  mdl_number: string;
  court: string;
  judge: string;
}): Record<string, string> {
  const today = new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return {
    matter: matter.name,
    mdl: matter.mdl_number,
    judge: matter.judge,
    court: matter.court,
    date: today,
    // manual fields left blank until the user fills them
  };
}
