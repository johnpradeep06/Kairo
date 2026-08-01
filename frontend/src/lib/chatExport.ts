/**
 * chatExport.ts
 * Client-side chat export utilities for Kairo.
 * Supports Markdown, Plain Text, and PDF formats.
 * No server round-trips – purely browser-based.
 */

type Message = {
    role: "user" | "assistant";
    content: string;
};

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function getTimestamp(): string {
    return new Date().toLocaleString("en-IN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function buildFilename(ext: string): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return `kairo-chat-${ts}.${ext}`;
}

// -------------------------------------------------------
// Markdown Export
// -------------------------------------------------------

export function exportAsMarkdown(messages: Message[]): void {
    const lines: string[] = [
        "# Kairo — Chat Export",
        "",
        `> Exported on ${getTimestamp()}`,
        "",
        "---",
        "",
    ];

    for (const msg of messages) {
        const label = msg.role === "user" ? "**You**" : "**Kairo**";
        lines.push(`### ${label}`);
        lines.push("");
        lines.push(msg.content);
        lines.push("");
        lines.push("---");
        lines.push("");
    }

    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    triggerDownload(blob, buildFilename("md"));
}

// -------------------------------------------------------
// Plain Text Export
// -------------------------------------------------------

export function exportAsPlainText(messages: Message[]): void {
    const lines: string[] = [
        "KAIRO — CHAT EXPORT",
        "===================",
        `Exported on ${getTimestamp()}`,
        "",
        "---",
        "",
    ];

    for (const msg of messages) {
        const label = msg.role === "user" ? "YOU" : "KAIRO";
        lines.push(`[${label}]`);
        lines.push(msg.content);
        lines.push("");
        lines.push("---");
        lines.push("");
    }

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    triggerDownload(blob, buildFilename("txt"));
}

// -------------------------------------------------------
// PDF Export  (uses jsPDF loaded from CDN if not bundled)
// -------------------------------------------------------

export async function exportAsPDF(messages: Message[]): Promise<void> {
    // Dynamically import jsPDF so it doesn't bloat the initial bundle
    const { jsPDF } = await import("jspdf");

    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

    const PAGE_W = 210;
    const MARGIN = 15;
    const CONTENT_W = PAGE_W - MARGIN * 2;
    const LINE_H = 6;
    const PAGE_H = 297;
    const FOOTER_H = 15;

    let y = MARGIN;

    // ---- Helper: add new page when near bottom ----
    const ensureSpace = (needed: number) => {
        if (y + needed > PAGE_H - FOOTER_H) {
            doc.addPage();
            y = MARGIN;
        }
    };

    // ---- Title block ----
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.setTextColor(120, 80, 220); // purple
    doc.text("Kairo — Chat Export", MARGIN, y);
    y += 8;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(130, 130, 130);
    doc.text(`Exported on ${getTimestamp()}`, MARGIN, y);
    y += 4;

    // Divider
    doc.setDrawColor(60, 60, 60);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
    y += 8;

    // ---- Messages ----
    for (const msg of messages) {
        const isUser = msg.role === "user";
        const label = isUser ? "You" : "Kairo";
        const bgColor: [number, number, number] = isUser ? [50, 50, 50] : [35, 30, 55];
        const labelColor: [number, number, number] = isUser ? [200, 200, 200] : [160, 120, 255];

        // Role label
        ensureSpace(10);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.setTextColor(...labelColor);
        doc.text(label, MARGIN, y);
        y += 5;

        // Bubble background + wrapped text
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(220, 220, 220);

        const wrapped = doc.splitTextToSize(msg.content, CONTENT_W - 4);
        const bubbleH = wrapped.length * LINE_H + 6;

        ensureSpace(bubbleH + 4);
        doc.setFillColor(...bgColor);
        doc.roundedRect(MARGIN, y - 2, CONTENT_W, bubbleH, 2, 2, "F");

        for (const line of wrapped) {
            ensureSpace(LINE_H);
            doc.text(line, MARGIN + 3, y + 3);
            y += LINE_H;
        }

        y += 8; // gap between messages
    }

    // ---- Footer on each page ----
    const totalPages = doc.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);
        doc.setFont("helvetica", "italic");
        doc.setFontSize(8);
        doc.setTextColor(100, 100, 100);
        doc.text(
            `Kairo AI Support Assistant  •  Page ${p} of ${totalPages}`,
            MARGIN,
            PAGE_H - 8
        );
    }

    doc.save(buildFilename("pdf"));
}
