import { useMemo, useState } from 'react';
import {
  CalendarClock,
  ClipboardList,
  FileSearch,
  FileSignature,
  Gavel,
  ListChecks,
  Mail,
  PenLine,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// The litigation skill launcher: MDL-literate starting forms for the Depo-Provera /
// GLP-1 practice. Extracted from the draft route unchanged; plus MARKUP_PRESETS — the
// whole-document review passes that run through the verified-redline pipeline instead
// of the chat writer.

export type DraftTemplate = {
  category: 'Correspondence' | 'Motions & Briefs' | 'Discovery' | 'Case Management' | 'Hearing Prep' | 'Leadership / PSC';
  icon: typeof Mail;
  title: string;
  docType: string;
  summary: string;
  prompt: string;
};

export const DRAFT_TEMPLATES: DraftTemplate[] = [
  // ---------- Correspondence ----------
  {
    category: 'Correspondence', icon: Mail, title: 'Meet-and-confer letter', docType: 'Letter',
    summary: 'Discovery deficiencies, numbered, tied to the controlling order.',
    prompt: 'Draft a meet-and-confer letter from Seeger Weiss LLP to defense liaison counsel addressing outstanding discovery deficiencies. Use full letter form: date line, addressee block, "Re: In re Depo-Provera Prods. Liab. Litig., MDL No. 3140 — Outstanding Discovery Deficiencies" line, salutation, body organized as numbered deficiency items each citing the controlling discovery order and the specific request at issue, a proposal of meet-and-confer times within the next seven days, and a closing signature block for [ATTORNEY NAME], Seeger Weiss LLP. Reserve all rights. Insert [BRACKETED ALL-CAPS] placeholders for any fact not in the record.',
  },
  {
    category: 'Correspondence', icon: Mail, title: 'Rule 26(f) follow-up letter', docType: 'Letter',
    summary: 'Memorialize 26(f) topics and open items for joint report.',
    prompt: 'Draft a Rule 26(f) follow-up letter from Seeger Weiss LLP to defense liaison counsel memorializing the parties\' discussion of the Fed. R. Civ. P. 26(f) topics. Letter form with caption "Re:" line referencing MDL No. 3140. Numbered sections: initial disclosures, ESI protocol status, protective order, discovery sequencing, anticipated motion practice, and proposed deadlines for the joint Rule 26(f) report. Flag points of disagreement neutrally. Signature block with [ATTORNEY NAME].',
  },
  {
    category: 'Correspondence', icon: Mail, title: 'Letter to Magistrate Cannon', docType: 'Letter',
    summary: 'Pre-motion discovery dispute letter per the operative procedure.',
    prompt: 'Draft a pre-motion discovery dispute letter to Magistrate Judge Hope T. Cannon following the procedure set out in the operative discovery management order. Brief letter form: date, "The Honorable Hope T. Cannon, United States Magistrate Judge, United States District Court, Northern District of Florida, Pensacola Division", "Re: In re Depo-Provera Prods. Liab. Litig., MDL No. 3140 — [SUBJECT]", salutation, three to four short numbered paragraphs stating (1) the dispute, (2) what plaintiffs sought and when, (3) defendants\' position and the parties\' meet-and-confer efforts, and (4) the limited relief requested. Cite the controlling order. Sign-off "Respectfully submitted," with [ATTORNEY NAME], Seeger Weiss LLP, on behalf of Plaintiffs\' co-lead counsel.',
  },
  {
    category: 'Correspondence', icon: Mail, title: 'Litigation-hold reminder', docType: 'Notice',
    summary: 'Refresher hold to client group, scoped to known custodians.',
    prompt: 'Draft a litigation-hold reminder memorandum from Seeger Weiss LLP to participating plaintiffs\' counsel and named-plaintiff clients. Memorandum form (TO / FROM / DATE / RE), referencing In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Sections: scope of duty to preserve, categories of materials to preserve (medical records, prescription history, communications with prescribers, social media, device data), preservation steps, prohibition on auto-deletion, and contact for questions. Place [BRACKETED ALL-CAPS] placeholders where facts vary by client.',
  },

  // ---------- Motions & Briefs ----------
  {
    category: 'Motions & Briefs', icon: Gavel, title: 'Motion to compel — outline', docType: 'Motion',
    summary: 'Argument headings, governing standard, and proposed relief.',
    prompt: 'Draft a detailed outline for Plaintiffs\' Motion to Compel Discovery. Begin with the full court caption (UNITED STATES DISTRICT COURT, NORTHERN DISTRICT OF FLORIDA, PENSACOLA DIVISION; In re Depo-Provera caption; MDL No. 3140; Judge Rodgers; Magistrate Judge Cannon). Title: "PLAINTIFFS\' MOTION TO COMPEL DISCOVERY". Sections: Introduction; Background (meet-and-confer history, pin-cited to letters); Legal Standard (Fed. R. Civ. P. 26(b)(1), 37(a), Eleventh Circuit authority); Argument with numbered headings (I., II., A., B.) addressing each disputed request; Conclusion / Proposed Relief; signature block for Plaintiffs\' Co-Lead Counsel; Certificate of Service. Use [BRACKETED ALL-CAPS] placeholders for case-specific facts.',
  },
  {
    category: 'Motions & Briefs', icon: Gavel, title: 'Daubert / Rule 702 response section', docType: 'Brief Section',
    summary: 'General-causation expert defense, ties to the gating hearing.',
    prompt: 'Draft a brief section responding to a Rule 702 / Daubert challenge to Plaintiffs\' general-causation expert(s) on the meningioma–medroxyprogesterone acetate association. No caption — produce the brief section only, suitable for insertion into a larger opposition. Numbered headings (I. Legal Standard; II. Dr. [EXPERT NAME]\'s Methodology Satisfies Rule 702; A. Reliability; B. Fit; III. Defendants\' Critiques Go to Weight, Not Admissibility). Cite Daubert, Kumho Tire, the 2023 amendments to Rule 702, and Eleventh Circuit authority (e.g., Chapman v. Procter & Gamble, McClain v. Metabolife). Use [BRACKETED ALL-CAPS] for expert names, study citations, and record pin cites.',
  },
  {
    category: 'Motions & Briefs', icon: Gavel, title: 'Opposition to motion to quash', docType: 'Brief',
    summary: 'Third-party subpoena defense; relevance and proportionality.',
    prompt: 'Draft an opposition brief responding to a non-party\'s motion to quash a Rule 45 subpoena duces tecum issued by Plaintiffs. Full caption (MDL No. 3140, Judge Rodgers, Magistrate Cannon). Title: "PLAINTIFFS\' OPPOSITION TO [NON-PARTY]\'S MOTION TO QUASH". Sections: Introduction; Factual Background (the subpoena and meet-and-confer); Legal Standard (Fed. R. Civ. P. 45(d), 26(b)(1)); Argument (relevance to general causation, proportionality, narrow tailoring, no undue burden, willingness to negotiate protective terms); Conclusion; signature block; Certificate of Service. Insert [BRACKETED ALL-CAPS] placeholders for the non-party identity and document categories.',
  },
  {
    category: 'Motions & Briefs', icon: Gavel, title: 'Motion to seal under PO', docType: 'Motion',
    summary: 'Narrow sealing request tied to the operative confidentiality order.',
    prompt: 'Draft an unopposed motion to file under seal pursuant to the operative Confidentiality / Protective Order in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Full caption. Title: "UNOPPOSED MOTION TO FILE UNDER SEAL". Sections: Introduction (one paragraph identifying the document and the protective-order designation), Legal Standard (Eleventh Circuit common-law right of access; *Chicago Tribune Co. v. Bridgestone/Firestone, Inc.* test), Argument (narrow tailoring, redactions considered, defendants\' designation), Conclusion / Proposed Order. Signature block; proposed order paragraphs in a separate section labeled "[PROPOSED] ORDER". Insert [BRACKETED ALL-CAPS] placeholders.',
  },

  // ---------- Discovery ----------
  {
    category: 'Discovery', icon: FileSignature, title: "Plaintiffs' First RFPs", docType: 'Discovery Request',
    summary: 'Numbered RFPs with definitions and instructions block.',
    prompt: 'Draft Plaintiffs\' First Set of Requests for Production to Defendants in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Full caption. Title: "PLAINTIFFS\' FIRST SET OF REQUESTS FOR PRODUCTION TO DEFENDANTS". Sections: I. Definitions (Plaintiffs, Defendants, Depo-Provera, Document, Communication, Concerning, Relevant Time Period, etc.); II. Instructions (incorporate Fed. R. Civ. P. 26 and 34 and the operative ESI protocol); III. Requests (numbered RFP No. 1–[N] on topics including general-causation research, pharmacovigilance signals on meningioma, label change history, FDA correspondence, internal risk assessments). Signature block. Each request on one substantive item.',
  },
  {
    category: 'Discovery', icon: FileSignature, title: 'Subpoena duces tecum (non-party)', docType: 'Subpoena',
    summary: 'Rule 45 schedule of documents to produce.',
    prompt: 'Draft Schedule A to a Fed. R. Civ. P. 45 subpoena duces tecum to a non-party in connection with In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Sections: I. Definitions; II. Instructions; III. Documents to be Produced (numbered categories, each scoped narrowly to a defined relevant time period and subject). Note that the subpoena form itself is the AO 88B and need not be reproduced; produce Schedule A only. Use [BRACKETED ALL-CAPS] placeholders for the non-party name and subject matter.',
  },
  {
    category: 'Discovery', icon: FileSignature, title: 'ESI protocol stipulation', docType: 'Stipulation',
    summary: 'Skeleton ESI protocol tracking the operative CMO.',
    prompt: 'Draft a stipulated ESI protocol for In re Depo-Provera Prods. Liab. Litig., MDL No. 3140, tracking the operative case management order. Full caption. Title: "STIPULATED ORDER GOVERNING THE PRODUCTION OF ELECTRONICALLY STORED INFORMATION". Numbered sections: 1. Cooperation; 2. Scope; 3. Custodians and Sources; 4. Search Methodology (TAR / search terms / negotiation); 5. Production Format (TIFF + load file, native for spreadsheets/presentations, color-as-kept); 6. Metadata Fields (table); 7. De-Duplication and Email Threading; 8. Privilege (logging, FRE 502(d)); 9. Hyperlinked / Modern Attachments; 10. Disputes (meet-and-confer, then to Magistrate Judge Cannon); 11. Modification. Signature lines for both sides and "SO ORDERED" line for Magistrate Judge Cannon.',
  },

  // ---------- Case Management ----------
  {
    category: 'Case Management', icon: ListChecks, title: 'Joint status report', docType: 'Status Report',
    summary: 'Pre-CMC report to Judge Rodgers on open items.',
    prompt: 'Draft a Joint Status Report to The Honorable M. Casey Rodgers in advance of the next status conference in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Full caption. Title: "JOINT STATUS REPORT". Numbered sections: I. Case Inventory (transfers, direct filings, anticipated tag-alongs); II. Plaintiff Fact Sheets / Threshold Proof Compliance; III. Defendant Fact Sheets; IV. Document Discovery (status by custodian, hit-report progress); V. Deposition Schedule; VI. Expert Discovery / Daubert; VII. Bellwether Process; VIII. Pending Motions; IX. Proposed Agenda Items. Use a neutral joint voice; insert "Plaintiffs\' Position:" / "Defendants\' Position:" subheadings where the parties disagree. Dual signature block.',
  },
  {
    category: 'Case Management', icon: ListChecks, title: 'Proposed PTO/CMO', docType: 'Proposed Order',
    summary: 'Caption + IT IS ORDERED numbered paragraphs.',
    prompt: 'Draft a proposed Pretrial / Case Management Order for In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Full caption. Title: "PRETRIAL ORDER NO. [XX]: [SHORT SUBJECT]". One-paragraph recital noting the Court\'s consideration of the parties\' submissions and conference, then "Accordingly, IT IS ORDERED that:" followed by numbered operative paragraphs (1., 2., 3.) each stating a single obligation, deadline, or procedure. Close with "DONE AND ORDERED in Chambers in Pensacola, Florida, this [DATE]." and a signature line for "M. CASEY RODGERS, UNITED STATES DISTRICT JUDGE". Insert [BRACKETED ALL-CAPS] placeholders for fact-specific terms.',
  },
  {
    category: 'Case Management', icon: CalendarClock, title: 'Status-conference agenda', docType: 'Agenda',
    summary: 'PSC-facing internal agenda for the next status conference.',
    prompt: 'Draft an internal status-conference agenda for the Plaintiffs\' Steering Committee in advance of the next conference before Judge Rodgers in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Memorandum-style header (TO: PSC; FROM: Co-Lead Counsel; DATE: [INSERT DATE]; RE: Status Conference Agenda). Numbered agenda items grouped under headings: I. Case Inventory; II. Discovery; III. Expert / Daubert; IV. Bellwether Process; V. Pending Motions; VI. Scheduling; VII. Common-Benefit Administration. Under each item, brief bullets for talking points and the proposed speaker. Insert [BRACKETED ALL-CAPS] placeholders.',
  },
  {
    category: 'Case Management', icon: CalendarClock, title: 'Deadline & obligations summary', docType: 'Memo',
    summary: 'Tabular summary of upcoming dates from the operative CMO.',
    prompt: 'Draft a memorandum summarizing upcoming deadlines and each party\'s obligations under the operative case management order in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Memorandum header (TO / FROM / DATE / RE). Section 1: a Markdown table with columns "Date | Event | Source (PTO/CMO ¶) | Plaintiffs\' Obligation | Defendants\' Obligation". Section 2: narrative discussion of the three most operationally significant deadlines and any conflicts. Cite each row to the controlling order using short forms ("CMO-3 § II.B"). Use [BRACKETED ALL-CAPS] for any obligation not supported by the record.',
  },

  // ---------- Hearing Prep ----------
  {
    category: 'Hearing Prep', icon: FileSearch, title: 'Matter briefing (CMC prep)', docType: 'Briefing Memo',
    summary: 'The 90-second "prep me for the conference" memo, grounded in the record.',
    prompt: 'Prepare a matter-briefing memorandum for Plaintiffs\' co-lead counsel ahead of the next status conference in this MDL. Memorandum header (TO / FROM / DATE / RE). Sections: I. Posture (two paragraphs, where the litigation stands); II. Controlling Orders — what governs right now (each with a record cite); III. Upcoming Deadlines and Obligations (dated list, cited); IV. Open Workstreams (discovery, PFS/census compliance, experts, bellwether); V. Anticipated Issues at the Conference; VI. Recommended Positions. Ground every record assertion in the provided passages with citations; where the record set provided does not cover an item, mark it [CONFIRM: cite controlling order] rather than asserting it.',
  },
  {
    category: 'Hearing Prep', icon: FileSearch, title: 'Bench memo', docType: 'Bench Memo',
    summary: 'Internal bench memo for an upcoming hearing.',
    prompt: 'Draft an internal bench memo for Plaintiffs\' co-lead counsel preparing for an upcoming hearing in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Header: "MEMORANDUM" with TO / FROM / DATE / RE block. Sections: I. Question Presented; II. Short Answer; III. Background; IV. Discussion (numbered argument with subheadings A., B.); V. Anticipated Questions from the Court; VI. Recommended Talking Points; VII. Open Issues / Follow-up. Bluebook citations throughout. Use [BRACKETED ALL-CAPS] placeholders for record pin cites and witness/expert names.',
  },
  {
    category: 'Hearing Prep', icon: FileSearch, title: 'Cross-examination outline', docType: 'Outline',
    summary: 'Topic-driven cross outline for an expert witness.',
    prompt: 'Draft a cross-examination outline for [EXPERT WITNESS NAME], a defense general-causation expert in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Header with witness name, role, and date of testimony [INSERT DATE]. Sections by topic (I., II., III.), each topic broken into lettered subtopics (A., B.), each subtopic broken into numbered questions (1., 2.) with the anticipated answer in parentheses or italics, and an exhibit reference where applicable (e.g., "[Ex. 4 — 2019 deposition at 112:14–18]"). End with "Loose Ends" and "Impeachment Reserves" sections. Place [BRACKETED ALL-CAPS] for facts not in the record.',
  },

  // ---------- Leadership / PSC ----------
  {
    category: 'Leadership / PSC', icon: ClipboardList, title: 'Common-benefit time memo', docType: 'PSC Memo',
    summary: 'Submission instructions to participating firms.',
    prompt: 'Draft a memorandum from Plaintiffs\' Co-Lead Counsel to all participating plaintiffs\' firms in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140, setting out the procedures for submitting common-benefit time and expenses under the operative Common Benefit Order. Memorandum header (TO / FROM / DATE / RE). Sections: I. Authority (cite the controlling CBO); II. What Qualifies as Common-Benefit Work; III. Time Submission Procedure (format, monthly deadline, contemporaneous-records requirement, billable categories); IV. Expense Submission Procedure; V. Audit and Approval; VI. Contact. Use [BRACKETED ALL-CAPS] for the time-keeper contact, monthly cut-off, and CBO paragraph numbers if not in the record.',
  },
  {
    category: 'Leadership / PSC', icon: ClipboardList, title: 'Lone Pine compliance analysis', docType: 'Analysis Memo',
    summary: 'Threshold-proof / Lone Pine compliance read.',
    prompt: 'Draft an internal analysis memorandum for the Plaintiffs\' Steering Committee evaluating Lone Pine / threshold-proof compliance issues in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Memorandum header (TO: PSC; FROM: Co-Lead Counsel; DATE: [INSERT DATE]; RE: Threshold-Proof Compliance — Analysis and Recommendations). Sections: I. The Operative Order (summarize the threshold-proof requirements with pin cites); II. Categories of Non-Compliance Observed; III. Legal Standard for Dismissal / Show-Cause; IV. Recommended Compliance Push (deadlines, communications, escalation); V. Risk Assessment. Use [BRACKETED ALL-CAPS] for case-counts and dates not in the record.',
  },
];

export const TEMPLATE_CATEGORIES: DraftTemplate['category'][] = [
  'Correspondence', 'Motions & Briefs', 'Discovery', 'Case Management', 'Hearing Prep', 'Leadership / PSC',
];

// Whole-document review passes — routed through the verified-redline pipeline
// (tracked-change suggestions with per-edit accept/reject), not the chat writer.
export const MARKUP_PRESETS: { title: string; instruction: string }[] = [
  {
    title: 'Proofread — grammar & typos',
    instruction: 'Proofread this document: fix grammatical errors, typos, subject-verb agreement, and punctuation as replace edits. Do not change substance, structure, or citations.',
  },
  {
    title: 'Tighten the prose',
    instruction: 'Tighten this document: eliminate redundancy, convert passive voice to active where it strengthens the sentence, and sharpen wordy constructions. Smallest sufficient edits; preserve all substance, defined terms, and citations.',
  },
  {
    title: 'Conform to record (grounded)',
    instruction: 'Review this document against the record passages provided. Where the document asserts a record fact the passages support, leave it (or add the correct cite). Where it conflicts with the passages, propose a corrected edit with a cite. Where it asserts a record fact the passages neither support nor contradict, add a comment flagging it for verification.',
  },
  {
    title: 'Flag unsupported assertions (comments only)',
    instruction: 'Review this document and add comment ops only — do not edit text. Flag: (1) every record assertion (dates, order numbers, deadlines, holdings, quotes) that should be verified against the record; (2) any argument that needs authority cited; (3) internally inconsistent statements.',
  },
  {
    title: 'Formalize register',
    instruction: 'Elevate this document to formal litigation register: replace casual phrasing, contractions, and imprecise verbs with precise, professional equivalents. Keep meaning identical; do not restructure.',
  },
];

export function TemplateLauncher({
  onPick, disabled,
}: { onPick: (t: DraftTemplate) => void; disabled: boolean }) {
  const [cat, setCat] = useState<DraftTemplate['category']>('Correspondence');
  const items = useMemo(() => DRAFT_TEMPLATES.filter((t) => t.category === cat), [cat]);
  return (
    <div className="py-3 px-1">
      <div className="text-center mb-4 px-2">
        <Sparkles className="h-5 w-5 mx-auto mb-2.5 text-accent/70" />
        <p className="font-serif text-[15px] text-foreground/85 mb-1">Draft from a litigation template.</p>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Pick a starting form below, or describe what you need. With grounding on, factual claims are
          cited to the controlling orders in Bluebook short form.
        </p>
      </div>

      <div className="-mx-1 mb-3 overflow-x-auto">
        <div className="flex gap-1 px-1 min-w-min">
          {TEMPLATE_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              className={cn(
                'shrink-0 rounded-full px-2.5 py-1 text-[11px] font-sans transition border',
                cat === c
                  ? 'bg-accent/10 border-accent/40 text-accent'
                  : 'bg-card border-border text-muted-foreground hover:border-accent/30 hover:text-foreground',
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        {items.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.title}
              type="button"
              onClick={() => onPick(t)}
              disabled={disabled}
              className="group w-full flex items-start gap-2.5 rounded-md border border-border bg-card px-3 py-2.5 text-left transition hover:border-accent/50 hover:bg-accent/5 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Icon className="h-4 w-4 text-accent shrink-0 mt-0.5" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12.5px] font-sans font-medium text-foreground/90 leading-snug truncate">{t.title}</span>
                  <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70 font-sans shrink-0">{t.docType}</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{t.summary}</p>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-4 rounded-md border border-accent/25 bg-accent/[0.04] px-3 py-2.5">
        <div className="flex items-center gap-1.5 mb-1">
          <PenLine className="h-3.5 w-3.5 text-accent" />
          <span className="text-[11px] font-sans font-medium text-foreground/85">Or mark up the open document</span>
        </div>
        <p className="text-[10.5px] leading-snug text-muted-foreground">
          Switch to the <span className="text-foreground/75">Changes</span> tab to run a review pass —
          suggestions arrive as tracked changes, each anchored to text verified to exist in the document.
        </p>
      </div>
    </div>
  );
}
