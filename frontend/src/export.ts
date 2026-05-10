import { jsPDF } from 'jspdf';

/**
 * Export utilities for EchoMesh documents.
 *
 * Supports PDF (via jsPDF), Markdown (.md), and plain text (.txt).
 */
export class Exporter {
  /** Export document text as a PDF. */
  static toPDF(text: string, title = 'EchoMesh Document'): void {
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
    });

    // Title
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.setTextColor(40, 40, 40);
    doc.text(title, 20, 25);

    // Timestamp
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(120, 120, 120);
    doc.text(`Exported from EchoMesh • ${new Date().toLocaleString()}`, 20, 32);

    // Divider
    doc.setDrawColor(200, 200, 200);
    doc.line(20, 35, 190, 35);

    // Body text
    doc.setFont('courier', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(30, 30, 30);

    const lines = doc.splitTextToSize(text, 170);
    const lineHeight = 5;
    let y = 42;

    for (const line of lines) {
      if (y > 280) {
        doc.addPage();
        y = 20;
      }
      doc.text(line, 20, y);
      y += lineHeight;
    }

    // Footer
    const pageCount = doc.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(`Page ${i} of ${pageCount}`, 105, 290, { align: 'center' });
    }

    doc.save(`${title.replace(/\s+/g, '_')}.pdf`);
  }

  /** Export as Markdown file. */
  static toMarkdown(text: string, title = 'EchoMesh Document'): void {
    const content = `# ${title}\n\n${text}\n\n---\n*Exported from EchoMesh • ${new Date().toLocaleString()}*\n`;
    download(content, `${title.replace(/\s+/g, '_')}.md`, 'text/markdown');
  }

  /** Export as plain text file. */
  static toText(text: string, title = 'EchoMesh Document'): void {
    download(text, `${title.replace(/\s+/g, '_')}.txt`, 'text/plain');
  }

  /** Export whiteboard as PNG. */
  static toPNG(dataUrl: string, title = 'EchoMesh Whiteboard'): void {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `${title.replace(/\s+/g, '_')}.png`;
    link.click();
  }
}

function download(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}