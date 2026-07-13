import { useEffect } from 'react';
import {
  ArrowDownToLine,
  BookOpen,
  FileText,
  FileUp,
  ListChecks,
  PenLine,
  Plus,
  Sparkles,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import type { WorkspaceDocument } from '@/lib/supabase';

// ⌘K command palette for the Drafting Workspace: jump between documents, start or import
// a document, run checks, toggle grounding, export. Attorneys who live in Word notice
// keyboard fluency immediately — this is that surface.

export interface PaletteTemplate {
  title: string;
  category: string;
  prompt: string;
}

export function CommandPalette({
  open,
  onOpenChange,
  docs,
  activeId,
  templates,
  ground,
  onPickDoc,
  onNew,
  onImport,
  onRunTemplate,
  onToggleGround,
  onExportDocx,
  onExportPdf,
  onExportMd,
  onOpenChecks,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  docs: WorkspaceDocument[];
  activeId: string | null;
  templates: PaletteTemplate[];
  ground: boolean;
  onPickDoc: (d: WorkspaceDocument) => void;
  onNew: () => void;
  onImport: () => void;
  onRunTemplate: (t: PaletteTemplate) => void;
  onToggleGround: () => void;
  onExportDocx: () => void;
  onExportPdf: () => void;
  onExportMd: () => void;
  onOpenChecks: () => void;
}) {
  // global ⌘K / ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const runAnd = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search documents, skills, actions…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem onSelect={runAnd(onNew)}>
            <Plus className="mr-2 h-4 w-4" /> New document
          </CommandItem>
          <CommandItem onSelect={runAnd(onImport)}>
            <FileUp className="mr-2 h-4 w-4" /> Open .docx…
          </CommandItem>
          <CommandItem onSelect={runAnd(onOpenChecks)}>
            <ListChecks className="mr-2 h-4 w-4" /> Run document checks
          </CommandItem>
          <CommandItem onSelect={runAnd(onToggleGround)}>
            <BookOpen className="mr-2 h-4 w-4" /> {ground ? 'Turn record grounding off' : 'Turn record grounding on'}
          </CommandItem>
          <CommandItem onSelect={runAnd(onExportDocx)}>
            <ArrowDownToLine className="mr-2 h-4 w-4" /> Export Word (.docx)
          </CommandItem>
          <CommandItem onSelect={runAnd(onExportPdf)}>
            <ArrowDownToLine className="mr-2 h-4 w-4" /> Print / Save as PDF
          </CommandItem>
          <CommandItem onSelect={runAnd(onExportMd)}>
            <ArrowDownToLine className="mr-2 h-4 w-4" /> Export Markdown
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Documents">
          {docs.map((d) => (
            <CommandItem
              key={d.id}
              value={`doc ${d.title}`}
              onSelect={runAnd(() => onPickDoc(d))}
            >
              <FileText className="mr-2 h-4 w-4" />
              <span className="truncate">{d.title || 'Untitled document'}</span>
              {d.id === activeId && <span className="ml-auto text-[10px] text-muted-foreground">current</span>}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Draft from a litigation skill">
          {templates.map((t) => (
            <CommandItem
              key={`${t.category}:${t.title}`}
              value={`skill ${t.category} ${t.title}`}
              onSelect={runAnd(() => onRunTemplate(t))}
            >
              {t.category === 'Markup' ? (
                <PenLine className="mr-2 h-4 w-4 text-accent" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4 text-accent" />
              )}
              <span className="truncate">{t.title}</span>
              <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">{t.category}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
