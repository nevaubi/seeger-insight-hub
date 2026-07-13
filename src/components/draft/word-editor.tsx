import { useCallback, useEffect, useRef, useState } from 'react';
import { SuperDocEditor, type SuperDocRef } from '@superdoc-dev/react';
import '@superdoc-dev/react/style.css';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase, WORKSPACE_DOCX_BUCKET } from '@/lib/supabase';

// Word mode: the SuperDoc canvas (OOXML-native, real pagination, native tracked changes
// and comments) for documents stored as .docx binaries in the workspace-docx bucket.
// This module is heavy (embedded editor runtime) — it is ONLY reached through
// React.lazy from the draft route, so memo-mode users never pay for it.
//
// The document round-trips losslessly: download from storage → edit → debounced
// export({triggerDownload:false}) → upsert back to storage. The "Suggest" switch flips
// documentMode to SuperDoc's suggesting mode, where every edit (human, for now) records
// as a tracked change with author attribution — the same review surface the memo-mode
// verified-redline pipeline targets.

export interface WordEditorApi {
  /** Full-fidelity .docx export via SuperDoc (native download). */
  exportDocx: (name: string) => Promise<void>;
  /** Plain text of the document body (for chat grounding context / checks). */
  extractText: () => string;
}

function htmlToText(htmlSections: string[]): string {
  const div = document.createElement('div');
  return htmlSections
    .map((h) => {
      div.innerHTML = h;
      return div.textContent ?? '';
    })
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default function WordEditor({
  storagePath,
  onSaveStateChange,
  onTextChange,
  onApi,
}: {
  storagePath: string;
  onSaveStateChange: (s: { saving: boolean; lastSavedAt: number | null; dirty: boolean }) => void;
  onTextChange: (text: string) => void;
  onApi: (api: WordEditorApi | null) => void;
}) {
  const ref = useRef<SuperDocRef | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // download the binary once per storagePath
  useEffect(() => {
    let alive = true;
    setFile(null);
    setReady(false);
    setLoadError(null);
    (async () => {
      const { data, error } = await supabase.storage.from(WORKSPACE_DOCX_BUCKET).download(storagePath);
      if (!alive) return;
      if (error || !data) {
        setLoadError(error?.message ?? 'Could not download the document');
        return;
      }
      setFile(new File([data], storagePath.split('/').pop() ?? 'document.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }));
    })();
    return () => {
      alive = false;
    };
  }, [storagePath]);

  const doSave = useCallback(async () => {
    const sd = ref.current?.getInstance();
    if (!sd || savingRef.current) return;
    savingRef.current = true;
    onSaveStateChange({ saving: true, lastSavedAt: null, dirty: dirtyRef.current });
    try {
      const blob = await sd.export({ triggerDownload: false, exportType: ['docx'], commentsType: 'external' });
      const { error } = await supabase.storage
        .from(WORKSPACE_DOCX_BUCKET)
        .upload(storagePath, blob, { upsert: true, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      if (error) throw new Error(error.message);
      dirtyRef.current = false;
      onSaveStateChange({ saving: false, lastSavedAt: Date.now(), dirty: false });
    } catch (e) {
      onSaveStateChange({ saving: false, lastSavedAt: null, dirty: true });
      toast.error(`Word autosave failed: ${(e as Error).message}`);
    } finally {
      savingRef.current = false;
    }
  }, [storagePath, onSaveStateChange]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    onSaveStateChange({ saving: false, lastSavedAt: null, dirty: true });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void doSave(), 2500);
  }, [doSave, onSaveStateChange]);

  const pushText = useCallback(() => {
    if (textTimer.current) clearTimeout(textTimer.current);
    textTimer.current = setTimeout(() => {
      const sd = ref.current?.getInstance();
      if (!sd) return;
      try {
        onTextChange(htmlToText(sd.getHTML()));
      } catch {
        /* extraction is best-effort */
      }
    }, 1200);
  }, [onTextChange]);

  // expose the api to the parent once ready
  useEffect(() => {
    if (!ready) return;
    onApi({
      exportDocx: async (name: string) => {
        const sd = ref.current?.getInstance();
        if (!sd) return;
        await sd.export({ exportType: ['docx'], exportedName: name });
      },
      extractText: () => {
        const sd = ref.current?.getInstance();
        if (!sd) return '';
        try {
          return htmlToText(sd.getHTML());
        } catch {
          return '';
        }
      },
    });
    return () => onApi(null);
  }, [ready, onApi]);

  // flush pending save on unmount
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (textTimer.current) clearTimeout(textTimer.current);
      if (dirtyRef.current) void doSave();
    };
  }, [doSave]);

  const toggleSuggesting = (v: boolean) => {
    const sd = ref.current?.getInstance();
    if (!sd) return;
    sd.setDocumentMode(v ? 'suggesting' : 'editing');
    setSuggesting(v);
  };

  if (loadError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center">
          <AlertTriangle className="h-5 w-5 mx-auto mb-2 text-amber-600" />
          <p className="text-sm text-foreground/80 mb-1">Couldn't open this Word document.</p>
          <p className="text-xs text-muted-foreground">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Opening document…
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border bg-secondary/40">
        <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
          Word mode · full fidelity
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground font-sans cursor-pointer">
          Track changes
          <input
            type="checkbox"
            checked={suggesting}
            onChange={(e) => toggleSuggesting(e.target.checked)}
            className="accent-[var(--accent)] h-3.5 w-3.5"
          />
        </label>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <SuperDocEditor
          ref={ref}
          document={file}
          documentMode="editing"
          user={{ name: 'Insight Hub Reviewer', email: 'reviewer@insight-hub.local' }}
          contained
          className="h-full"
          renderLoading={() => (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Rendering…
            </div>
          )}
          onReady={() => {
            setReady(true);
            pushText();
          }}
          onEditorUpdate={() => {
            scheduleSave();
            pushText();
          }}
          onContentError={(e) => {
            setLoadError('This .docx could not be parsed with full fidelity.');
            console.warn('SuperDoc content error', e);
          }}
          onException={(e) => console.warn('SuperDoc exception', e)}
        />
      </div>
    </div>
  );
}
