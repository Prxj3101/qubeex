// Some scanned textbook PDFs (state-board books especially) embed their page
// images as JPEG2000 (JPXDecode) in a CMYK colorspace. pdf.js — the library
// qubeex-app/qubeex-web use to render PDFs in the Blackboard — has a known,
// long-standing bug decoding that specific combination: the image decode
// silently stalls forever and the page renders with that image permanently
// blank, while logging "Dependent image isn't ready yet" to the console.
// Chrome's own native PDF viewer (a completely different engine, PDFium)
// handles the exact same file fine, which is why this only shows up inside
// our own app.
//
// The fix isn't something we can do in our rendering code — it's an
// upstream pdf.js limitation. Instead, we normalize the PDF's images at
// upload time: re-encode any JPXDecode/CMYK images to plain JPEG/RGB via
// Ghostscript, which pdf.js has no trouble with. This runs once, at
// upload, not on every view.
//
// Detection is a cheap raw-byte scan for the literal "/JPXDecode" filter
// name — PDF filter names live in the (uncompressed) object dictionary, not
// inside the compressed stream data, so a plain buffer search reliably
// finds it without needing a real PDF parser. The vast majority of
// uploaded PDFs won't contain it at all, so they skip Ghostscript entirely
// and upload exactly as before.

import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

// The Ghostscript binary is named "gs" on Linux/Railway (production) but
// "gswin64c" on 64-bit Windows (a local dev machine) — try the
// platform-appropriate name first, but fall back to the other in case
// someone's Windows install is 32-bit or PATH is set up unusually.
const GS_BIN_CANDIDATES = process.platform === "win32"
  ? ["gswin64c", "gswin32c", "gs"]
  : ["gs"];

function needsNormalization(buffer: Buffer): boolean {
  return buffer.includes("/JPXDecode");
}

// Ghostscript flags: force every color/gray image through DCTEncode (plain
// JPEG) and convert the whole document's color space to RGB. Verified
// end-to-end against a real 112-page scanned board textbook — eliminates
// JPXDecode and DeviceCMYK entirely, and the file still renders visually
// identical afterward.
const GS_ARGS = [
  "-sDEVICE=pdfwrite",
  "-dCompatibilityLevel=1.4",
  "-dPDFSETTINGS=/ebook",
  "-dColorConversionStrategy=/RGB",
  "-dProcessColorModel=/DeviceRGB",
  "-dAutoFilterColorImages=false",
  "-dColorImageFilter=/DCTEncode",
  "-dAutoFilterGrayImages=false",
  "-dGrayImageFilter=/DCTEncode",
  "-dEncodeColorImages=true",
  "-dEncodeGrayImages=true",
  "-dNOPAUSE",
  "-dBATCH",
];

export type PdfNormalizeStatus = "skipped" | "success" | "failed";

export interface PdfNormalizeResult {
  buffer: Buffer;
  status: PdfNormalizeStatus;
}

// Returns the normalized PDF buffer, or the original buffer unchanged if
// normalization wasn't needed or Ghostscript failed for any reason — an
// upload must never be blocked by this step. `status` lets callers tell a
// legitimate "didn't need it" apart from "tried and failed" so the failure
// case can be surfaced to the user instead of silently swallowed.
export async function normalizePdfIfNeeded(buffer: Buffer): Promise<PdfNormalizeResult> {
  console.log(`[pdfNormalize] checking upload (${buffer.length} bytes)...`);
  if (!needsNormalization(buffer)) {
    console.log("[pdfNormalize] no /JPXDecode found — uploading as-is");
    return { buffer, status: "skipped" };
  }
  console.log("[pdfNormalize] /JPXDecode found — running Ghostscript...");

  const tmpId = crypto.randomUUID();
  const inputPath = path.join(os.tmpdir(), `pdf-in-${tmpId}.pdf`);
  const outputPath = path.join(os.tmpdir(), `pdf-out-${tmpId}.pdf`);

  try {
    await fs.writeFile(inputPath, buffer);

    let ran = false;
    let lastErr: unknown;
    for (const bin of GS_BIN_CANDIDATES) {
      try {
        await execFileAsync(bin, [...GS_ARGS, `-sOutputFile=${outputPath}`, inputPath], {
          // Large scanned textbooks (200+ pages) can legitimately take a
          // couple minutes on Railway's CPU — 120s was cutting it close and
          // silently falling back to the unconverted file. 5 minutes gives
          // real headroom while still not hanging an upload forever.
          timeout: 300_000,
          maxBuffer: 1024 * 1024 * 10,
        });
        ran = true;
        break;
      } catch (err) {
        lastErr = err;
        // ENOENT here means "this binary name doesn't exist" — try the next
        // candidate. Any other error (a real Ghostscript failure on this
        // specific file) should stop immediately rather than retry.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") throw err;
      }
    }
    if (!ran) throw lastErr;

    const normalized = await fs.readFile(outputPath);
    // Ghostscript can "succeed" (exit 0) but still emit a near-empty or
    // truncated file on some malformed inputs — sanity-check size before
    // trusting it over the original.
    if (normalized.length < 1024) {
      console.error("[pdfNormalize] Ghostscript output suspiciously small, keeping original");
      return { buffer, status: "failed" };
    }
    console.log(`[pdfNormalize] done — ${buffer.length} bytes -> ${normalized.length} bytes`);
    return { buffer: normalized, status: "success" };
  } catch (err) {
    console.error("[pdfNormalize] Ghostscript normalization failed, uploading original file:", err);
    return { buffer, status: "failed" };
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}
