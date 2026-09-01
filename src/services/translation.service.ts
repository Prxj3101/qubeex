// src/services/translation.service.ts
//
// Machine translation for teacher-entered free text shown in the qubeex-app
// "Parent Mode" screen when a parent selects Hindi or Marathi. Static UI
// labels are translated on the frontend via a hardcoded dictionary — this
// service only handles DYNAMIC text (Marksheet Conduct/Remarks, flag
// category/title/detail/actionTaken/reviewRemark) that a teacher typed and
// can't be pre-translated ahead of time.
//
// Uses Azure Translator (Text Translation API). Results are cached in the
// TranslationCache table keyed by a hash of (source text + target language),
// so the same sentence is only ever billed/translated once, no matter how
// many parents/students view it afterwards.
//
// Required env vars:
//   AZURE_TRANSLATOR_KEY    = Azure Translator resource key (Keys and Endpoint blade)
//   AZURE_TRANSLATOR_REGION = Azure Translator resource region, e.g. "centralindia"

import crypto from "crypto";
import { academicDb } from "../utils/academicContext";

const AZURE_TRANSLATOR_KEY = process.env.AZURE_TRANSLATOR_KEY;
const AZURE_TRANSLATOR_REGION = process.env.AZURE_TRANSLATOR_REGION;
const AZURE_TRANSLATOR_ENDPOINT = "https://api.cognitive.microsofttranslator.com";

export type DynamicTranslateLang = "hi" | "mr";

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Translates a batch of free-text strings to the target language, using the
 * TranslationCache table to avoid re-translating text that's been seen
 * before (same Conduct/Remarks/flag text gets viewed by the same parent
 * repeatedly, and often shared across students in the same class).
 *
 * Empty/blank strings are passed through untouched (nothing to translate,
 * and no point spending a cache row or an API call on them).
 */
export async function translateBatch(texts: string[], targetLang: DynamicTranslateLang): Promise<string[]> {
  if (texts.length === 0) return [];

  const db = academicDb();
  const hashes = texts.map(t => hashText(t));

  const cached = await db.translationCache.findMany({
    where: { sourceTextHash: { in: hashes }, targetLang },
  });
  const cacheByHash = new Map(cached.map(c => [c.sourceTextHash, c.translatedText]));

  // Figure out which (unique) texts still need translating, preserving the
  // original text so we can send it to Azure and write it back to cache.
  const missing = new Map<string, string>(); // hash -> original text
  texts.forEach((text, i) => {
    if (!text.trim()) return;
    if (!cacheByHash.has(hashes[i])) missing.set(hashes[i], text);
  });

  if (missing.size > 0) {
    if (!AZURE_TRANSLATOR_KEY || !AZURE_TRANSLATOR_REGION) {
      console.error("[translation] AZURE_TRANSLATOR_KEY / AZURE_TRANSLATOR_REGION not configured — returning original text untranslated.");
    } else {
      const missingHashes = [...missing.keys()];
      const missingTexts = [...missing.values()];

      try {
        const res = await fetch(
          `${AZURE_TRANSLATOR_ENDPOINT}/translate?api-version=3.0&to=${targetLang}`,
          {
            method: "POST",
            headers: {
              "Ocp-Apim-Subscription-Key": AZURE_TRANSLATOR_KEY,
              "Ocp-Apim-Subscription-Region": AZURE_TRANSLATOR_REGION,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(missingTexts.map(text => ({ text }))),
            signal: AbortSignal.timeout(10000),
          }
        );

        if (!res.ok) {
          console.error(`[translation] Azure Translator returned ${res.status} for lang=${targetLang}`);
        } else {
          const json = (await res.json()) as Array<{ translations: Array<{ text: string }> }>;

          const rows = missingHashes.map((hash, i) => ({
            sourceTextHash: hash,
            targetLang,
            translatedText: json[i]?.translations?.[0]?.text ?? missingTexts[i],
          }));

          for (const row of rows) {
            cacheByHash.set(row.sourceTextHash, row.translatedText);
          }

          // Cache writes are best-effort — a duplicate insert (two concurrent
          // requests translating the same new sentence) is fine to ignore.
          await Promise.all(
            rows.map(row =>
              db.translationCache
                .upsert({
                  where: { sourceTextHash_targetLang: { sourceTextHash: row.sourceTextHash, targetLang: row.targetLang } },
                  create: row,
                  update: { translatedText: row.translatedText },
                })
                .catch(err => console.error("[translation] cache write failed:", err))
            )
          );
        }
      } catch (err) {
        console.error(`[translation] Azure Translator request failed for lang=${targetLang}:`, err);
      }
    }
  }

  // Return in the original order/shape, falling back to the source text for
  // anything blank or that failed to translate.
  return texts.map((text, i) => (text.trim() ? cacheByHash.get(hashes[i]) ?? text : text));
}
