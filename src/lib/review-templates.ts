import type { ReviewColumnType } from '@/lib/supabase';

export interface TemplateColumn {
  name: string;
  data_type: ReviewColumnType;
  prompt: string;
  enum_options?: string[];
}

export interface ReviewTemplate {
  id: string;
  name: string;
  description: string;
  columns: TemplateColumn[];
}

export const REVIEW_TEMPLATES: ReviewTemplate[] = [
  {
    id: 'order-cmo-tracker',
    name: 'Order & CMO Tracker',
    description:
      'For pretrial orders, case management orders, and standing orders — captures each order’s identity, what it governs, the deadlines it sets, and how it relates to prior orders.',
    columns: [
      { name: 'Order type', data_type: 'enum', prompt: 'Classify the order into exactly one category based on its caption and content.', enum_options: ['Pretrial Order', 'Case Management Order', 'Common Benefit Order', 'Scheduling Order', 'Protective Order', 'Transfer Order', 'Other'] },
      { name: 'Order number', data_type: 'text', prompt: 'The order’s number or designation exactly as captioned (for example "PTO 22", "CMO 5", "PTO 22A"). Leave blank if unnumbered.' },
      { name: 'Date issued', data_type: 'date', prompt: 'The date the order was signed or entered by the court.' },
      { name: 'Governs / subject', data_type: 'text', prompt: 'A concise statement of what this order governs or establishes (its principal subject).' },
      { name: 'Deadlines set', data_type: 'list', prompt: 'Every deadline or dated obligation the order imposes, each stated as "trigger or date — what is due". Empty if none.' },
      { name: 'Applies to', data_type: 'enum', prompt: 'Who the order’s obligations principally fall on.', enum_options: ['Plaintiffs', 'Defendants', 'Leadership', 'All parties', 'Third parties'] },
      { name: 'Amends / supersedes', data_type: 'text', prompt: 'Any prior order this one amends, supersedes, or supplements, identified by number. Blank if it stands alone.' },
      { name: 'Summary', data_type: 'text', prompt: 'A one-sentence summary of the order’s operative effect.' },
    ],
  },
  {
    id: 'motion-practice-tracker',
    name: 'Motion Practice Tracker',
    description: 'For motions and their disposition — motion type, movant, relief sought, briefing deadlines, and how the court ruled.',
    columns: [
      { name: 'Motion type', data_type: 'enum', prompt: 'Classify the motion into exactly one category.', enum_options: ['Motion to Dismiss', 'Motion for Summary Judgment', 'Motion to Compel', 'Motion in Limine', 'Daubert Motion', 'Motion for Class Certification', 'Motion to Remand', 'Motion to Strike', 'Other'] },
      { name: 'Filed by', data_type: 'enum', prompt: 'Which side filed the motion.', enum_options: ['Plaintiffs', 'Defendants', 'Third party', 'Joint'] },
      { name: 'Relief sought', data_type: 'text', prompt: 'The specific relief the motion asks the court to grant.' },
      { name: 'Date filed', data_type: 'date', prompt: 'The date the motion was filed.' },
      { name: 'Response deadline', data_type: 'text', prompt: 'Any opposition or response deadline stated, as a date or trigger. Blank if none.' },
      { name: 'Disposition', data_type: 'enum', prompt: 'How the court ruled, if stated in this document.', enum_options: ['Granted', 'Denied', 'Granted in part', 'Pending', 'Withdrawn', 'Deferred'] },
      { name: 'Ruling date', data_type: 'date', prompt: 'The date of the ruling, if stated.' },
      { name: 'Basis / standard', data_type: 'text', prompt: 'The legal standard or principal basis cited for the motion or ruling.' },
    ],
  },
  {
    id: 'pleadings-analyzer',
    name: 'Pleadings Analyzer',
    description: 'For complaints and answers — parties, claims, jurisdictional basis, and the relief demanded.',
    columns: [
      { name: 'Pleading type', data_type: 'enum', prompt: 'Classify the pleading into exactly one category.', enum_options: ['Complaint', 'Amended Complaint', 'Master Complaint', 'Short-Form Complaint', 'Answer', 'Counterclaim', 'Cross-claim', 'Other'] },
      { name: 'Plaintiffs', data_type: 'list', prompt: 'The named plaintiff(s).' },
      { name: 'Defendants', data_type: 'list', prompt: 'The named defendant(s).' },
      { name: 'Causes of action', data_type: 'list', prompt: 'Each count or cause of action asserted, stated concisely.' },
      { name: 'Jurisdictional basis', data_type: 'text', prompt: 'The asserted basis for the court\u2019s jurisdiction (diversity, federal question, etc.).' },
      { name: 'Relief demanded', data_type: 'text', prompt: 'The relief or damages demanded.' },
      { name: 'Jury demand', data_type: 'boolean', prompt: 'Does the pleading demand a jury trial?' },
      { name: 'Class allegations', data_type: 'boolean', prompt: 'Does the pleading assert class-action allegations?' },
    ],
  },

  {
    id: 'deposition-digest',
    name: 'Deposition Digest',
    description: 'For deposition transcripts — the deponent, key admissions, and exhibits, with page:line references.',
    columns: [
      { name: 'Deponent', data_type: 'text', prompt: 'The full name and role of the witness being deposed.' },
      { name: 'Deposition date', data_type: 'date', prompt: 'The date the deposition was taken.' },
      { name: 'Key admissions', data_type: 'list', prompt: 'The most significant admissions or concessions by the witness, each with its page:line reference in the form "p.NN:LL — admission".' },
      { name: 'Topics covered', data_type: 'list', prompt: 'The principal subject areas examined.' },
      { name: 'Exhibits referenced', data_type: 'list', prompt: 'Exhibit numbers or descriptions marked or discussed.' },
      { name: 'Objections of note', data_type: 'text', prompt: 'Any notable objections, instructions not to answer, or privilege assertions, with page:line where possible.' },
    ],
  },
  {
    id: 'plaintiff-fact-sheet',
    name: 'Plaintiff Fact Sheet',
    description: 'For plaintiff fact sheets / profile forms — the core proof-of-use and proof-of-injury facts used in bellwether selection.',
    columns: [
      { name: 'Plaintiff name', data_type: 'text', prompt: 'The plaintiff’s full name.' },
      { name: 'Product use period', data_type: 'text', prompt: 'The dates or date range of the plaintiff’s use of the product at issue.' },
      { name: 'Injury alleged', data_type: 'text', prompt: 'The specific injury or condition the plaintiff alleges.' },
      { name: 'Diagnosis date', data_type: 'date', prompt: 'The date of the alleged diagnosis, if stated.' },
      { name: 'Treating providers', data_type: 'list', prompt: 'Named treating physicians, hospitals, or providers.' },
      { name: 'Prescriber', data_type: 'text', prompt: 'The prescribing physician, if identified.' },
      { name: 'Alternative exposure', data_type: 'boolean', prompt: 'Does the plaintiff report use of any alternative or competing product that could be an alternative cause?' },
    ],
  },
  {
    id: 'expert-daubert-matrix',
    name: 'Expert & Daubert Matrix',
    description: 'For expert reports — opinions, methodology, and reliability factors relevant to a Rule 702 / Daubert challenge.',
    columns: [
      { name: 'Expert name', data_type: 'text', prompt: 'The expert’s full name.' },
      { name: 'Field / specialty', data_type: 'text', prompt: 'The expert’s field of expertise and the discipline the opinion sounds in.' },
      { name: 'Retained by', data_type: 'enum', prompt: 'Which side retained this expert, if stated.', enum_options: ['Plaintiffs', 'Defendants', 'Court', 'Unclear'] },
      { name: 'Opinions offered', data_type: 'list', prompt: 'Each distinct opinion the expert offers, stated concisely.' },
      { name: 'Methodology', data_type: 'text', prompt: 'The methodology or basis the expert relies on (studies, differential diagnosis, and so on).' },
      { name: 'General causation opinion', data_type: 'boolean', prompt: 'Does the report opine on general causation?' },
      { name: 'Reliability concerns', data_type: 'text', prompt: 'Any stated assumptions, limitations, or analytical gaps a Daubert challenge could target.' },
    ],
  },
  {
    id: 'medical-chronology',
    name: 'Medical Record Chronology',
    description: 'For medical records — a dated chronology of encounters, diagnoses, and treatment.',
    columns: [
      { name: 'Date of service', data_type: 'date', prompt: 'The date of the encounter or record.' },
      { name: 'Provider / facility', data_type: 'text', prompt: 'The provider or facility.' },
      { name: 'Chief complaint', data_type: 'text', prompt: 'The presenting complaint or reason for the visit.' },
      { name: 'Diagnosis', data_type: 'list', prompt: 'Diagnoses or impressions recorded.' },
      { name: 'Treatment / medications', data_type: 'list', prompt: 'Treatments, procedures, or medications noted.' },
      { name: 'Relevant findings', data_type: 'text', prompt: 'Findings relevant to the alleged injury or causation.' },
    ],
  },
  {
    id: 'discovery-bates-log',
    name: 'Discovery / Bates Log',
    description: 'For produced documents — Bates ranges, custodian, and privilege posture.',
    columns: [
      { name: 'Bates range', data_type: 'text', prompt: 'The Bates number or range stamped on the document.' },
      { name: 'Custodian / source', data_type: 'text', prompt: 'The custodian or source of the document, if indicated.' },
      { name: 'Document date', data_type: 'date', prompt: 'The date the document bears.' },
      { name: 'Document type', data_type: 'enum', prompt: 'The kind of document.', enum_options: ['Email', 'Memo', 'Report', 'Contract', 'Presentation', 'Notes', 'Other'] },
      { name: 'Author / sender', data_type: 'text', prompt: 'The author or sender.' },
      { name: 'Recipients', data_type: 'list', prompt: 'Recipients or addressees.' },
      { name: 'Privilege flag', data_type: 'boolean', prompt: 'Does the document appear to be privileged or marked confidential / privileged?' },
    ],
  },
  {
    id: 'document-metadata',
    name: 'Document Metadata',
    description: 'Universal document metadata — type, caption, date, parties, court, and author. Works on any document.',
    columns: [
      { name: 'Document type', data_type: 'enum', prompt: 'Classify this document into exactly one of the listed categories based on its form and content.', enum_options: ['Order', 'Motion', 'Brief', 'Letter', 'Agreement', 'Expert Report', 'Deposition', 'Email', 'Pleading', 'Other'] },
      { name: 'Title / caption', data_type: 'text', prompt: 'The full title or caption of this document, exactly as it appears.' },
      { name: 'Date', data_type: 'date', prompt: 'The principal date of the document (date filed, signed, or issued).' },
      { name: 'Parties', data_type: 'list', prompt: 'All named parties to this document (plaintiffs, defendants, signatories).' },
      { name: 'Court / forum', data_type: 'text', prompt: 'The court, tribunal, or forum named in the document. Leave blank if none.' },
      { name: 'Author / signer', data_type: 'text', prompt: 'The author or signing party (judge, attorney, executive, and so on).' },
    ],
  },
];
