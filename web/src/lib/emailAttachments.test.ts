import { describe, it, expect } from "vitest";
import {
  MAX_ATTACHMENT_FILES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  validateAttachmentSelection,
  formatBytes,
  isPdf,
  fileToBase64,
} from "./emailAttachments";

const pdf = (name: string, size = 1000, type = "application/pdf") => ({ name, size, type });
const MB = 1024 * 1024;

describe("isPdf", () => {
  it("accepts by MIME type or .pdf extension (any case)", () => {
    expect(isPdf({ name: "a.bin", type: "application/pdf" })).toBe(true);
    expect(isPdf({ name: "Rules.PDF", type: "" })).toBe(true);
    expect(isPdf({ name: "rules.pdf", type: "application/octet-stream" })).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isPdf({ name: "photo.png", type: "image/png" })).toBe(false);
    expect(isPdf({ name: "notes.pdf.txt", type: "text/plain" })).toBe(false);
  });
});

describe("validateAttachmentSelection", () => {
  it("accepts PDFs and returns the same objects", () => {
    const a = pdf("a.pdf");
    const b = pdf("b.PDF", 2000, "");
    const r = validateAttachmentSelection([], [a, b]);
    expect(r.accepted).toEqual([a, b]);
    expect(r.accepted[0]).toBe(a);
    expect(r.rejected).toEqual([]);
  });

  it("rejects non-PDFs with a reason", () => {
    const r = validateAttachmentSelection([], [pdf("photo.png", 500, "image/png"), pdf("ok.pdf")]);
    expect(r.accepted.map((f) => f.name)).toEqual(["ok.pdf"]);
    expect(r.rejected).toEqual([{ name: "photo.png", reason: expect.stringMatching(/PDF/) }]);
  });

  it("rejects empty files", () => {
    const r = validateAttachmentSelection([], [pdf("empty.pdf", 0)]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0]).toMatchObject({ name: "empty.pdf", reason: expect.stringMatching(/empty/i) });
  });

  it("skips names already attached, and duplicates within the same pick", () => {
    const r = validateAttachmentSelection([{ name: "a.pdf", size: 100 }], [pdf("a.pdf"), pdf("b.pdf"), pdf("b.pdf")]);
    expect(r.accepted.map((f) => f.name)).toEqual(["b.pdf"]);
    expect(r.rejected.map((x) => x.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(r.rejected[0].reason).toMatch(/already/i);
  });

  it("caps the file count including what's already attached", () => {
    const existing = Array.from({ length: MAX_ATTACHMENT_FILES - 1 }, (_, i) => ({ name: `e${i}.pdf`, size: 10 }));
    const r = validateAttachmentSelection(existing, [pdf("x.pdf"), pdf("y.pdf")]);
    expect(r.accepted.map((f) => f.name)).toEqual(["x.pdf"]);
    expect(r.rejected).toEqual([{ name: "y.pdf", reason: expect.stringContaining(`${MAX_ATTACHMENT_FILES}`) }]);
  });

  it("caps total bytes including what's already attached", () => {
    const existing = [{ name: "big.pdf", size: 4 * MB }];
    const r = validateAttachmentSelection(existing, [pdf("over.pdf", 1.5 * MB), pdf("fits.pdf", 0.5 * MB)]);
    expect(r.accepted.map((f) => f.name)).toEqual(["fits.pdf"]);
    expect(r.rejected[0]).toMatchObject({ name: "over.pdf", reason: expect.stringMatching(/5 MB/) });
  });

  it("allows exactly the byte limit", () => {
    const r = validateAttachmentSelection([], [pdf("exact.pdf", MAX_ATTACHMENT_TOTAL_BYTES)]);
    expect(r.accepted).toHaveLength(1);
    const over = validateAttachmentSelection([], [pdf("over.pdf", MAX_ATTACHMENT_TOTAL_BYTES + 1)]);
    expect(over.accepted).toHaveLength(0);
  });

  it("a rejected file does not consume count or bytes", () => {
    const r = validateAttachmentSelection([], [
      pdf("huge.pdf", 10 * MB),
      pdf("a.pdf"),
      pdf("b.pdf"),
      pdf("c.pdf"),
    ]);
    expect(r.accepted.map((f) => f.name)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    expect(r.rejected).toHaveLength(1);
  });
});

describe("formatBytes", () => {
  it("formats B / KB / MB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(24 * 1024 + 300)).toBe("24 KB");
    expect(formatBytes(1.25 * MB)).toBe("1.3 MB");
    expect(formatBytes(5 * MB)).toBe("5 MB");
    expect(formatBytes(12.4 * MB)).toBe("12 MB");
  });
  it("tolerates garbage", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("fileToBase64", () => {
  it("encodes a File's bytes", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"
    const file = new File([bytes], "tiny.pdf", { type: "application/pdf" });
    expect(await fileToBase64(file)).toBe("JVBERi0xLjQ=");
  });
});
