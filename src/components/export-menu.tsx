import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { downloadXlsx, downloadCsv, type Sheet, type Cell } from '@/lib/file-export';

/**
 * Export button + dropdown for tabular page data. Produces a real .xlsx (styled header
 * row, sized columns) and a UTF-8 CSV from the same column/row model. Disabled when there
 * is nothing to export.
 */
export function ExportMenu({
  baseName,
  sheetName,
  columns,
  rows,
  disabled,
  align = 'end',
  label = 'Export',
}: {
  baseName: string;
  sheetName: string;
  columns: { header: string; width?: number }[];
  rows: Cell[][];
  disabled?: boolean;
  align?: 'start' | 'end';
  label?: string;
}) {
  const count = rows.length;
  const isDisabled = disabled || count === 0;

  const doXlsx = () => {
    const sheet: Sheet = { name: sheetName, columns, rows };
    downloadXlsx(baseName, [sheet]);
    toast.success(`Exported ${count} ${count === 1 ? 'row' : 'rows'} to Excel`);
  };
  const doCsv = () => {
    downloadCsv(baseName, columns.map((c) => c.header), rows);
    toast.success(`Exported ${count} ${count === 1 ? 'row' : 'rows'} to CSV`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={isDisabled} className="gap-2 font-sans">
          <Download className="h-4 w-4" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-52">
        <DropdownMenuLabel className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
          {count} {count === 1 ? 'row' : 'rows'}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={doXlsx} className="gap-2 cursor-pointer">
          <FileSpreadsheet className="h-4 w-4 text-[hsl(150_50%_30%)]" />
          Excel workbook (.xlsx)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={doCsv} className="gap-2 cursor-pointer">
          <FileText className="h-4 w-4 text-muted-foreground" />
          CSV (.csv)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
